package main

import (
	"strings"
	"testing"
)

// Отчёт для поддержки не должен содержать ключей подписок, UUID, паролей и полных IP-адресов.
func TestRedact(t *testing.T) {
	in := `fetch failed (proxy port 10808): Get "https://sub.example.com/k/Zx9Qk2Lm7Vt4Rw8Yp3Nc6Hd1Sg5Jf0Ab_ExampleToken?x=1": dial tcp 203.0.113.77:443: timeout
helper 1.2.0 started, args=[chrome-extension://nigkplgdbbninkhcchhpbipafejcgkpp/]
uuid 11111111-2222-3333-4444-555555555555 key SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc listen 127.0.0.1:10808`
	out := redact(in)
	for _, bad := range []string{"Zx9Qk2Lm", "203.0.113.77", "11111111-2222", "SbVKOEMj"} {
		if strings.Contains(out, bad) {
			t.Errorf("секрет %q остался в отчёте:\n%s", bad, out)
		}
	}
	for _, good := range []string{"https://sub.example.com/…", "chrome-extension://nigkplgdbbninkhcchhpbipafejcgkpp", "127.0.0.1:10808", "203.0.x.x"} {
		if !strings.Contains(out, good) {
			t.Errorf("ожидалось, что %q останется:\n%s", good, out)
		}
	}
}
