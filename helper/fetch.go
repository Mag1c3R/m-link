package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxFetchBody = 32 << 20  // подписка больше 32 МБ — явно что-то не то
	chunkSize    = 600 << 10 // 600 КБ -> ~800 КБ в base64: Chrome не принимает от помощника сообщения больше 1 МБ
)

// Заголовки подписки, которые нужны расширению.
var passHeaders = []string{
	"content-type", "subscription-userinfo", "profile-title", "profile-update-interval",
	"support-url", "profile-web-page-url",
}

type fetchResult struct {
	status  int
	headers map[string]string
	body    []byte
	via     string
}

func doFetch(rawURL, ua string, proxyPort int) (*fetchResult, error) {
	tr := &http.Transport{Proxy: nil, ResponseHeaderTimeout: 15 * time.Second}
	via := "direct"
	if proxyPort > 0 {
		pu, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", proxyPort))
		tr.Proxy = http.ProxyURL(pu)
		via = "proxy"
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 25 * time.Second}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	req.Header.Set("Accept", "*/*")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxFetchBody {
		return nil, errors.New("ответ слишком большой")
	}
	headers := map[string]string{}
	for _, h := range passHeaders {
		if v := resp.Header.Get(h); v != "" {
			headers[h] = v
		}
	}
	return &fetchResult{status: resp.StatusCode, headers: headers, body: body, via: via}, nil
}

// fetchURL скачивает подписку. Если ядро запущено, сначала пробует через него
// (сервер подписки может быть недоступен напрямую). Если за 2 секунды ответа нет
// или он неудачный, параллельно пробует напрямую и берёт первый успешный ответ.
func fetchURL(rawURL, ua string) (*fetchResult, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("ссылка должна начинаться с http:// или https://")
	}
	proxyPort := core.proxyPort()
	if proxyPort == 0 {
		res, err := doFetch(u.String(), ua, 0)
		if err != nil {
			return nil, friendlyNetError(err)
		}
		return res, nil
	}

	type attempt struct {
		res *fetchResult
		err error
	}
	results := make(chan attempt, 2)
	run := func(port int) {
		go func() {
			res, err := doFetch(u.String(), ua, port)
			if err != nil {
				log.Printf("fetch failed (proxy port %d): %v", port, err)
			}
			results <- attempt{res, err}
		}()
	}
	run(proxyPort)
	running, directStarted := 1, false
	startDirect := func() {
		if !directStarted {
			directStarted = true
			running++
			run(0)
		}
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	var firstResp *fetchResult
	var lastErr error
	for running > 0 {
		select {
		case <-timer.C:
			startDirect()
		case a := <-results:
			running--
			if a.err == nil && a.res.status >= 200 && a.res.status < 300 {
				return a.res, nil
			}
			if a.err != nil {
				lastErr = a.err
			} else if firstResp == nil {
				firstResp = a.res
			}
			startDirect()
		}
	}
	if firstResp != nil {
		return firstResp, nil
	}
	return nil, friendlyNetError(lastErr)
}

func friendlyNetError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "no such host"):
		return errors.New("сервер подписки не найден (проверь ссылку)")
	case strings.Contains(msg, "Client.Timeout") || strings.Contains(msg, "timeout"):
		return errors.New("сервер подписки не ответил вовремя")
	case strings.Contains(msg, "connection refused"):
		return errors.New("сервер подписки отклонил соединение")
	case strings.Contains(msg, "certificate"):
		return errors.New("у сервера подписки проблема с сертификатом")
	}
	return fmt.Errorf("не удалось скачать подписку: %s", msg)
}

// replyChunked отправляет тело частями в base64, а затем итоговое сообщение с числом частей.
func replyChunked(id int, res *fetchResult) {
	parts := 0
	for off := 0; off < len(res.body); off += chunkSize {
		end := off + chunkSize
		if end > len(res.body) {
			end = len(res.body)
		}
		send(map[string]any{"id": id, "part": parts, "data": base64.StdEncoding.EncodeToString(res.body[off:end])})
		parts++
	}
	reply(id, map[string]any{"status": res.status, "headers": res.headers, "parts": parts, "size": len(res.body), "via": res.via})
}
