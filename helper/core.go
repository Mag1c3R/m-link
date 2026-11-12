package main

import (
	"errors"
	"fmt"
	"log"
	"net"
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

// ---------- поиск sing-box ----------

func coreName() string {
	if runtime.GOOS == "windows" {
		return "sing-box.exe"
	}
	return "sing-box"
}

func findCore() (string, error) {
	name := coreName()
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
	return "", errors.New("не найден sing-box: положи его рядом с помощником или установи (brew install sing-box)")
}

var (
	versionCache   = map[string]string{}
	versionCacheMu sync.Mutex
	versionRe      = regexp.MustCompile(`version\s+(\S+)`)
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
		if m := versionRe.FindSubmatch(out); m != nil {
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
	// Убираем ANSI-цвета из логов sing-box.
	return ansiRe.ReplaceAllString(strings.Join(lines, "\n"), "")
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// ---------- управление процессом ----------

type coreProcess struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	done    chan struct{}
	out     *tailBuffer
	stopped bool // остановлен нами, а не упал
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

// killStale гасит sing-box, оставшийся от прошлого запуска (например, если браузер упал).
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

var startMu sync.Mutex

func (c *coreProcess) start(path string, config []byte, port int) error {
	startMu.Lock()
	defer startMu.Unlock()
	c.stop()

	if portBusy(port) {
		killStale()
		if portBusy(port) {
			return fmt.Errorf("порт %d уже занят другой программой; поменяй порт в настройках", port)
		}
	}

	cfgPath := filepath.Join(dataDir, "config.json")
	if err := os.WriteFile(cfgPath, config, 0o600); err != nil {
		return fmt.Errorf("не удалось записать конфиг: %w", err)
	}

	out := &tailBuffer{max: 16 << 10}
	cmd := exec.Command(path, "run", "-c", cfgPath, "-D", dataDir)
	cmd.Stdout = out // важно: stdout помощника занят протоколом браузера
	cmd.Stderr = out
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("не удалось запустить sing-box: %w", err)
	}
	_ = os.WriteFile(pidFile(), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
	log.Printf("core started pid=%d port=%d", cmd.Process.Pid, port)

	done := make(chan struct{})
	c.mu.Lock()
	c.cmd, c.done, c.out, c.stopped = cmd, done, out, false
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
			return fmt.Errorf("sing-box не запустился: %s", firstNonEmpty(out.lastLines(4), "без вывода"))
		default:
		}
		if portBusy(port) {
			close(ready)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	c.stop()
	return errors.New("sing-box не открыл локальный порт за 10 секунд")
}

func (c *coreProcess) stop() {
	c.mu.Lock()
	cmd, done := c.cmd, c.done
	c.stopped = true
	c.cmd = nil
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

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
