package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// xrayTest меряет задержку узлов xray (XHTTP). У xray нет Clash API, поэтому запускаем один
// временный xray с отдельным SOCKS-входом на каждый узел и делаем запрос через каждый вход.
func xrayTest(path string, nodes []testNode, testURL string, timeoutMs int, onResult resultFunc) (map[string]int, error) {
	ports := make([]int, len(nodes))
	inbounds := make([]map[string]any, 0, len(nodes))
	outbounds := make([]map[string]any, 0, len(nodes)+1)
	rules := make([]map[string]any, 0, len(nodes))
	for i, n := range nodes {
		p, err := freePort()
		if err != nil {
			return nil, err
		}
		ports[i] = p
		in := fmt.Sprintf("in%d", i)
		out := fmt.Sprintf("out%d", i)
		inbounds = append(inbounds, map[string]any{
			"tag": in, "listen": "127.0.0.1", "port": p, "protocol": "socks",
			"settings": map[string]any{"auth": "noauth", "udp": false},
		})
		ob := map[string]any{}
		for k, v := range n.Xray {
			ob[k] = v
		}
		ob["tag"] = out
		outbounds = append(outbounds, ob)
		rules = append(rules, map[string]any{"type": "field", "inboundTag": []string{in}, "outboundTag": out})
	}
	outbounds = append(outbounds, map[string]any{"protocol": "blackhole", "tag": "block"})
	cfg := map[string]any{
		"log":       map[string]any{"loglevel": "error"},
		"inbounds":  inbounds,
		"outbounds": outbounds,
		"routing":   map[string]any{"rules": rules},
	}
	data, _ := json.Marshal(cfg)
	dir, err := os.MkdirTemp(dataDir, "xtest-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	cfgPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfgPath, data, 0o600); err != nil {
		return nil, err
	}

	out := &tailBuffer{max: 8 << 10}
	cmd := exec.Command(path, "run", "-c", cfgPath)
	cmd.Dir = dir
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

	// Ждём, пока xray откроет входы (последний открывается последним).
	ready := false
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
		select {
		case <-done:
			return nil, errors.New("xray для теста упал: " + out.lastLines(3))
		default:
		}
		if portBusy(ports[len(ports)-1]) {
			ready = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		return nil, errors.New("xray не открыл входы для теста")
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
			ms := measureVia(ports[i], testURL, timeoutMs)
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

// measureVia делает запрос к testURL через локальный SOCKS-вход и возвращает время в мс (-1 при ошибке).
// Как и Clash API, считаем время всего запроса, включая установку соединения с сервером.
func measureVia(port int, testURL string, timeoutMs int) int {
	pu, _ := url.Parse(fmt.Sprintf("socks5://127.0.0.1:%d", port))
	tr := &http.Transport{Proxy: http.ProxyURL(pu), DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: time.Duration(timeoutMs) * time.Millisecond}
	start := time.Now()
	resp, err := client.Get(testURL)
	if err != nil {
		return -1
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return -1
	}
	ms := int(time.Since(start).Milliseconds())
	if ms == 0 {
		ms = 1
	}
	return ms
}
