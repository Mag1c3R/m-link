package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

var udpTypes = map[string]bool{"hysteria2": true, "hysteria": true, "tuic": true}

// onResult вызывается для каждого узла сразу после его замера (может быть nil).
type resultFunc func(id string, ms int)

// latencyTest меряет реальную задержку: узлы sing-box — через временный sing-box с Clash API,
// узлы XHTTP — через временный xray. Если ядро недоступно или конфиг не прошёл,
// для этих узлов откатывается на TCP-пинг до сервера.
func latencyTest(nodes []testNode, testURL string, timeoutMs int, onResult resultFunc) (map[string]int, string) {
	if testURL == "" {
		testURL = "https://www.gstatic.com/generate_204"
	}
	if timeoutMs <= 0 {
		timeoutMs = 5000
	}
	var sb, xr []testNode
	for _, n := range nodes {
		if normalizeCore(n.Core) == coreXray {
			xr = append(xr, n)
		} else {
			sb = append(sb, n)
		}
	}

	results := map[string]int{}
	var mu sync.Mutex
	method := "urltest"
	merge := func(part map[string]int, m string) {
		mu.Lock()
		defer mu.Unlock()
		for k, v := range part {
			results[k] = v
		}
		if m == "tcp" {
			method = "tcp"
		}
	}
	run := func(list []testNode, kind string, measure func(path string) (map[string]int, error)) {
		if len(list) == 0 {
			return
		}
		if path, err := findBinary(kind); err == nil {
			res, err := measure(path)
			if err == nil {
				merge(res, "urltest")
				return
			}
			log.Printf("%s urltest failed, falling back to tcp: %v", kind, err)
		}
		merge(tcpTest(list, timeoutMs, onResult), "tcp")
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		run(sb, coreSingBox, func(path string) (map[string]int, error) {
			return urlTest(path, sb, testURL, timeoutMs, onResult)
		})
	}()
	go func() {
		defer wg.Done()
		run(xr, coreXray, func(path string) (map[string]int, error) {
			return xrayTest(path, xr, testURL, timeoutMs, onResult)
		})
	}()
	wg.Wait()
	return results, method
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func urlTest(corePath string, nodes []testNode, testURL string, timeoutMs int, onResult resultFunc) (map[string]int, error) {
	ctrlPort, err := freePort()
	if err != nil {
		return nil, err
	}
	outbounds := make([]map[string]any, 0, len(nodes)+1)
	for i, n := range nodes {
		ob := map[string]any{}
		for k, v := range n.Outbound {
			ob[k] = v
		}
		ob["tag"] = fmt.Sprintf("n%d", i)
		outbounds = append(outbounds, ob)
	}
	outbounds = append(outbounds, map[string]any{"type": "direct", "tag": "direct"})
	cfg := map[string]any{
		"log":       map[string]any{"level": "error"},
		"outbounds": outbounds,
		"route":     map[string]any{"final": "direct"},
		"experimental": map[string]any{
			"clash_api": map[string]any{"external_controller": fmt.Sprintf("127.0.0.1:%d", ctrlPort)},
		},
	}
	data, _ := json.Marshal(cfg)
	dir, err := os.MkdirTemp(dataDir, "test-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	cfgPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfgPath, data, 0o600); err != nil {
		return nil, err
	}

	out := &tailBuffer{max: 8 << 10}
	cmd := exec.Command(corePath, "run", "-c", cfgPath, "-D", dir)
	cmd.Stdout, cmd.Stderr = out, out
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	defer func() {
		_ = cmd.Process.Kill()
		<-done
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", ctrlPort)
	client := &http.Client{Timeout: time.Duration(timeoutMs+3000) * time.Millisecond}
	ready := false
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
		select {
		case <-done:
			return nil, errors.New("sing-box для теста упал: " + out.lastLines(3))
		default:
		}
		if r, err := client.Get(base + "/version"); err == nil {
			r.Body.Close()
			ready = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		return nil, errors.New("Clash API не поднялся")
	}

	results := make(map[string]int, len(nodes))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for i, n := range nodes {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, id string) {
			defer wg.Done()
			defer func() { <-sem }()
			q := url.Values{"url": {testURL}, "timeout": {fmt.Sprint(timeoutMs)}}
			u := fmt.Sprintf("%s/proxies/n%d/delay?%s", base, i, q.Encode())
			ms := -1
			if r, err := client.Get(u); err == nil {
				var body struct {
					Delay int `json:"delay"`
				}
				if r.StatusCode == 200 && json.NewDecoder(r.Body).Decode(&body) == nil && body.Delay > 0 {
					ms = body.Delay
				}
				r.Body.Close()
			}
			mu.Lock()
			results[id] = ms
			mu.Unlock()
			if onResult != nil {
				onResult(id, ms)
			}
		}(i, n.ID)
	}
	wg.Wait()
	return results, nil
}

// tcpTest — запасной вариант: время TCP-соединения до сервера. Для UDP-протоколов не применим.
func tcpTest(nodes []testNode, timeoutMs int, onResult resultFunc) map[string]int {
	results := make(map[string]int, len(nodes))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, n := range nodes {
		t, _ := n.Outbound["type"].(string)
		if udpTypes[t] || n.Server == "" || n.Port == 0 {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(n testNode) {
			defer wg.Done()
			defer func() { <-sem }()
			start := time.Now()
			ms := -1
			addr := net.JoinHostPort(n.Server, fmt.Sprint(n.Port))
			if c, err := net.DialTimeout("tcp", addr, time.Duration(timeoutMs)*time.Millisecond); err == nil {
				ms = int(time.Since(start).Milliseconds())
				if ms == 0 {
					ms = 1
				}
				c.Close()
			}
			mu.Lock()
			results[n.ID] = ms
			mu.Unlock()
			if onResult != nil {
				onResult(n.ID, ms)
			}
		}(n)
	}
	wg.Wait()
	return results
}
