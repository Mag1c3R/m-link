package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// probe делает один запрос к testURL и возвращает время в мс (-1, если ответа нет).
// direct=false — через работающее ядро, direct=true — мимо него.
func probe(testURL string, timeoutMs int, direct bool) (int, error) {
	if testURL == "" {
		testURL = "https://www.gstatic.com/generate_204"
	}
	if timeoutMs <= 0 {
		timeoutMs = 6000
	}
	if !direct {
		port := core.proxyPort()
		if port == 0 {
			return 0, errors.New("ядро не запущено")
		}
		return measureVia(port, testURL, timeoutMs), nil
	}
	tr := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: time.Duration(timeoutMs) * time.Millisecond}
	start := time.Now()
	resp, err := client.Get(testURL)
	if err != nil {
		return -1, nil
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return -1, nil
	}
	ms := int(time.Since(start).Milliseconds())
	if ms == 0 {
		ms = 1
	}
	return ms, nil
}

var (
	reURL    = regexp.MustCompile(`(https?)://([^/\s"'?#]+)[^\s"']*`)
	reUUID   = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	reExtID  = regexp.MustCompile(`chrome-extension://[a-p]{32}`)
	reToken  = regexp.MustCompile(`[A-Za-z0-9_+/=-]{24,}`)
	reIPv4   = regexp.MustCompile(`\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b`)
	reMarker = regexp.MustCompile(`\x00(\d+)\x00`)
)

// redact убирает из текста всё, что может быть секретом: пути и параметры ссылок (в них ключи подписок),
// UUID, длинные ключи и пароли, хвосты IP-адресов, имя пользователя в путях.
func redact(s string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		s = strings.ReplaceAll(s, home, "~")
	}
	// ID расширения не секрет и нужен для диагностики: прячем его от общей замены ключей.
	var keep []string
	s = reExtID.ReplaceAllStringFunc(s, func(m string) string {
		keep = append(keep, m)
		return fmt.Sprintf("\x00%d\x00", len(keep)-1)
	})
	s = reURL.ReplaceAllString(s, "$1://$2/…")
	s = reUUID.ReplaceAllString(s, "<uuid>")
	s = reToken.ReplaceAllString(s, "<…>")
	s = reIPv4.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasPrefix(m, "127.") || m == "0.0.0.0" {
			return m
		}
		return reIPv4.ReplaceAllString(m, "$1.x.x")
	})
	return reMarker.ReplaceAllStringFunc(s, func(m string) string {
		var i int
		fmt.Sscanf(m, "\x00%d\x00", &i)
		if i >= 0 && i < len(keep) {
			return keep[i]
		}
		return ""
	})
}

// diagnostics собирает сведения для поддержки: версии, систему и хвост журнала без секретов.
func diagnostics() map[string]any {
	info := map[string]any{
		"version": version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
		"running": core.running(),
	}
	if path, err := findBinary(coreSingBox); err == nil {
		info["singbox"] = coreVersion(path)
	} else {
		info["singbox"] = "не найден"
	}
	if path, err := findBinary(coreXray); err == nil {
		info["xray"] = coreVersion(path)
	} else {
		info["xray"] = "не найден"
	}
	core.mu.Lock()
	if core.cmd != nil {
		info["core"] = core.kind
	}
	core.mu.Unlock()
	if b, err := os.ReadFile(filepath.Join(dataDir, "helper.log")); err == nil {
		lines := strings.Split(strings.TrimSpace(string(b)), "\n")
		if len(lines) > 60 {
			lines = lines[len(lines)-60:]
		}
		info["log"] = redact(strings.Join(lines, "\n"))
	}
	return info
}
