package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ядра, которые умеет запускать помощник. sing-box — основное; xray нужен для транспорта XHTTP,
// которого в sing-box нет.
const (
	coreSingBox = "sing-box"
	coreXray    = "xray"
)

func normalizeCore(kind string) string {
	if kind == coreXray {
		return coreXray
	}
	return coreSingBox
}

// ---------- поиск ядра ----------

func binName(kind string) string {
	if runtime.GOOS == "windows" {
		return kind + ".exe"
	}
	return kind
}

func findBinary(kind string) (string, error) {
	name := binName(kind)
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(dir, name), filepath.Join(dir, "core", name))
	}
	if dataDir != "" {
		candidates = append(candidates, filepath.Join(dataDir, name))
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	// Браузер, запущенный из Finder/Dock, получает урезанный PATH, поэтому проверяем типовые места.
	home, _ := os.UserHomeDir()
	for _, d := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", filepath.Join(home, ".local/bin"), filepath.Join(home, "go/bin")} {
		c := filepath.Join(d, name)
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	if kind == coreXray {
		return "", errors.New("не найдено ядро xray: установи помощник заново, оно входит в комплект")
	}
	return "", errors.New("не найден sing-box: положи его рядом с помощником или установи (brew install sing-box)")
}

// findCore оставлен для совместимости: основное ядро — sing-box.
func findCore() (string, error) { return findBinary(coreSingBox) }

var (
	versionCache   = map[string]string{}
	versionCacheMu sync.Mutex
	singboxVerRe   = regexp.MustCompile(`version\s+(\S+)`)
	xrayVerRe      = regexp.MustCompile(`Xray\s+(\S+)`)
)

func coreVersion(path string) string {
	versionCacheMu.Lock()
	defer versionCacheMu.Unlock()
	if v, ok := versionCache[path]; ok {
		return v
	}
	cmd := exec.Command(path, "version")
	hideWindow(cmd)
	out, err := cmd.Output()
	v := "?"
	if err == nil {
		re := singboxVerRe
		if strings.HasPrefix(strings.TrimSpace(string(out)), "Xray") {
			re = xrayVerRe
		}
		if m := re.FindSubmatch(out); m != nil {
			v = string(m[1])
		}
	}
	versionCache[path] = v
	return v
}

// ---------- кольцевой буфер для вывода ядра ----------

type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) lastLines(n int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.buf)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	// Убираем ANSI-цвета из логов ядра.
	return ansiRe.ReplaceAllString(strings.Join(lines, "\n"), "")
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// ---------- управление процессом ----------

type coreProcess struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	done        chan struct{}
	out         *tailBuffer
	kind        string
	port        int    // локальный порт входа работающего ядра
	statsPort   int    // порт Clash API для статистики (только sing-box)
	statsSecret string // секрет Clash API
	stopped     bool   // остановлен нами, а не упал
}

// proxyPort возвращает порт работающего ядра или 0, если оно не запущено.
func (c *coreProcess) proxyPort() int {
	if !c.running() {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.port
}

func (c *coreProcess) running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd == nil {
		return false
	}
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

func portBusy(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func pidFile() string { return filepath.Join(dataDir, "core.pid") }

// killStale гасит ядро, оставшееся от прошлого запуска (например, если браузер упал).
func killStale() {
	b, err := os.ReadFile(pidFile())
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return
	}
	if isCoreProcess(pid) {
		if p, err := os.FindProcess(pid); err == nil {
			log.Printf("killing stale core pid=%d", pid)
			_ = p.Kill()
			time.Sleep(300 * time.Millisecond)
		}
	}
	_ = os.Remove(pidFile())
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// withStatsAPI добавляет в конфиг sing-box Clash API на свободном порту, чтобы помощник мог
// отдавать расширению скорость соединения. Конфиг без изменений, если API уже задан.
func withStatsAPI(config []byte) ([]byte, int, string) {
	var cfg map[string]any
	if err := json.Unmarshal(config, &cfg); err != nil {
		return config, 0, ""
	}
	exp, _ := cfg["experimental"].(map[string]any)
	if exp == nil {
		exp = map[string]any{}
	}
	if _, ok := exp["clash_api"]; ok {
		return config, 0, ""
	}
	port, err := freePort()
	if err != nil {
		return config, 0, ""
	}
	secret := randomHex(16)
	exp["clash_api"] = map[string]any{"external_controller": fmt.Sprintf("127.0.0.1:%d", port), "secret": secret}
	cfg["experimental"] = exp
	out, err := json.Marshal(cfg)
	if err != nil {
		return config, 0, ""
	}
	return out, port, secret
}

var startMu sync.Mutex

func (c *coreProcess) start(kind, path string, config []byte, port int) error {
	startMu.Lock()
	defer startMu.Unlock()
	c.stop()

	if portBusy(port) {
		killStale()
		if portBusy(port) {
			return fmt.Errorf("порт %d уже занят другой программой; поменяй порт в настройках", port)
		}
	}

	statsPort, statsSecret := 0, ""
	if kind == coreSingBox {
		config, statsPort, statsSecret = withStatsAPI(config)
	}

	cfgPath := filepath.Join(dataDir, "config.json")
	if err := os.WriteFile(cfgPath, config, 0o600); err != nil {
		return fmt.Errorf("не удалось записать конфиг: %w", err)
	}

	out := &tailBuffer{max: 16 << 10}
	var cmd *exec.Cmd
	if kind == coreXray {
		cmd = exec.Command(path, "run", "-c", cfgPath)
		cmd.Dir = dataDir
	} else {
		cmd = exec.Command(path, "run", "-c", cfgPath, "-D", dataDir)
	}
	cmd.Stdout = out // важно: stdout помощника занят протоколом браузера
	cmd.Stderr = out
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("не удалось запустить %s: %w", kind, err)
	}
	_ = os.WriteFile(pidFile(), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
	log.Printf("core %s started pid=%d port=%d", kind, cmd.Process.Pid, port)

	done := make(chan struct{})
	c.mu.Lock()
	c.cmd, c.done, c.out, c.kind, c.port, c.stopped = cmd, done, out, kind, port, false
	c.statsPort, c.statsSecret = statsPort, statsSecret
	c.mu.Unlock()

	ready := make(chan struct{})
	go func() {
		err := cmd.Wait()
		close(done)
		c.mu.Lock()
		stopped := c.stopped
		c.mu.Unlock()
		log.Printf("core exited: %v (stopped=%v)\n%s", err, stopped, out.lastLines(10))
		select {
		case <-ready:
			if !stopped {
				send(map[string]any{"event": "exited", "error": firstNonEmpty(out.lastLines(3), fmt.Sprint(err))})
			}
		default:
		}
	}()

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return fmt.Errorf("%s не запустился: %s", kind, firstNonEmpty(out.lastLines(4), "без вывода"))
		default:
		}
		if portBusy(port) {
			close(ready)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	c.stop()
	return fmt.Errorf("%s не открыл локальный порт за 10 секунд", kind)
}

func (c *coreProcess) stop() {
	c.mu.Lock()
	cmd, done := c.cmd, c.done
	c.stopped = true
	c.cmd = nil
	c.statsPort, c.statsSecret = 0, ""
	c.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	terminate(cmd.Process)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
	_ = os.Remove(pidFile())
	log.Printf("core stopped")
}

// stats возвращает, сколько байт прошло через ядро с момента запуска.
// ok=false, если ядро не запущено или не умеет отдавать статистику (xray).
func (c *coreProcess) stats() (down, up int64, ok bool) {
	if !c.running() {
		return 0, 0, false
	}
	c.mu.Lock()
	port, secret := c.statsPort, c.statsSecret
	c.mu.Unlock()
	if port == 0 {
		return 0, 0, false
	}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/connections", port), nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, false
	}
	defer resp.Body.Close()
	var body struct {
		DownloadTotal int64 `json:"downloadTotal"`
		UploadTotal   int64 `json:"uploadTotal"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&body) != nil {
		return 0, 0, false
	}
	return body.DownloadTotal, body.UploadTotal, true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
