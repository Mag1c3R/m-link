package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Откуда помощник берёт обновления. Адрес зашит в код: расширение не может подсунуть
// помощнику другую ссылку. MLINK_UPDATE_API переопределяет его только для тестов.
const releasesAPI = "https://api.github.com/repos/Mag1c3R/m-link/releases/latest"

const maxArchiveBytes = 200 << 20

var updateMu sync.Mutex

type releaseInfo struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name   string `json:"name"`
		URL    string `json:"browser_download_url"`
		Digest string `json:"digest"`
	} `json:"assets"`
}

func versionLess(a, b string) bool {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func assetName() string {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf("m-link-helper-windows-%s.zip", runtime.GOARCH)
	}
	return fmt.Sprintf("m-link-helper-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
}

func httpGet(url string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "M-Link-Helper/"+version)
	req.Header.Set("Accept", "application/vnd.github+json")
	// Обновление качаем напрямую, мимо VPN: ядро в этот момент остановлено.
	client := &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("GitHub ответил %d", resp.StatusCode)
	}
	return resp, nil
}

// selfUpdate скачивает последний релиз помощника для этой системы, проверяет контрольную сумму
// и ставит его поверх текущего. Работает, только когда ядро остановлено.
func selfUpdate() (map[string]any, error) {
	updateMu.Lock()
	defer updateMu.Unlock()
	if core.running() {
		return nil, errors.New("сначала отключи VPN: во время обновления ядро должно быть остановлено")
	}
	api := releasesAPI
	if v := os.Getenv("MLINK_UPDATE_API"); v != "" {
		api = v
	}
	resp, err := httpGet(api, 20*time.Second)
	if err != nil {
		return nil, fmt.Errorf("не удалось узнать последнюю версию: %w", err)
	}
	var rel releaseInfo
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel)
	resp.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("не удалось прочитать ответ GitHub: %w", err)
	}
	latest := strings.TrimPrefix(rel.TagName, "v")
	if latest == "" || !versionLess(version, latest) {
		return map[string]any{"updated": false, "version": version, "latest": latest}, nil
	}

	name := assetName()
	var dlURL, digest string
	for _, a := range rel.Assets {
		if a.Name == name {
			dlURL, digest = a.URL, a.Digest
		}
	}
	if dlURL == "" {
		return nil, fmt.Errorf("в релизе %s нет архива для этой системы (%s)", latest, name)
	}
	if !strings.HasPrefix(digest, "sha256:") {
		return nil, errors.New("GitHub не сообщил контрольную сумму архива, обновление отменено")
	}
	want := strings.TrimPrefix(digest, "sha256:")

	tmp, err := os.MkdirTemp(dataDir, "update-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	archive := filepath.Join(tmp, name)
	if err := download(dlURL, archive, want); err != nil {
		return nil, err
	}
	src := filepath.Join(tmp, "x")
	if err := extract(archive, src); err != nil {
		return nil, fmt.Errorf("не удалось распаковать архив: %w", err)
	}
	pkg := filepath.Join(src, strings.TrimSuffix(strings.TrimSuffix(name, ".zip"), ".tar.gz"))
	if runtime.GOOS == "windows" {
		err = installWindows(pkg)
	} else {
		err = installUnix(pkg)
	}
	if err != nil {
		return nil, err
	}
	log.Printf("updated %s -> %s", version, latest)
	return map[string]any{"updated": true, "version": latest, "previous": version}, nil
}

func download(url, dst, wantSHA string) error {
	resp, err := httpGet(url, 5*time.Minute)
	if err != nil {
		return fmt.Errorf("не удалось скачать обновление: %w", err)
	}
	defer resp.Body.Close()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxArchiveBytes+1))
	f.Close()
	if err != nil {
		return fmt.Errorf("не удалось скачать обновление: %w", err)
	}
	if n > maxArchiveBytes {
		return errors.New("архив обновления слишком большой")
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, wantSHA) {
		return errors.New("контрольная сумма архива не совпала, обновление отменено")
	}
	return nil
}

// safeJoin не даёт файлам из архива выйти за пределы папки распаковки.
func safeJoin(root, name string) (string, error) {
	p := filepath.Join(root, filepath.FromSlash(name))
	if p != root && !strings.HasPrefix(p, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("подозрительный путь в архиве: %s", name)
	}
	return p, nil
}

func writeFile(path string, r io.Reader, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(r, maxArchiveBytes))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func extract(archive, dst string) error {
	if strings.HasSuffix(archive, ".zip") {
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer zr.Close()
		for _, f := range zr.File {
			p, err := safeJoin(dst, f.Name)
			if err != nil {
				return err
			}
			if f.FileInfo().IsDir() {
				if err := os.MkdirAll(p, 0o755); err != nil {
					return err
				}
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeFile(p, rc, 0o755)
			rc.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p, err := safeJoin(dst, h.Name)
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeFile(p, tr, os.FileMode(h.Mode)&0o755|0o600); err != nil {
				return err
			}
		}
	}
}

// На macOS и Linux запускаем установщик из нового архива: он заменит файлы и обновит
// регистрацию в браузерах (например, список разрешённых ID расширения).
func installUnix(pkg string) error {
	script := filepath.Join(pkg, "install.sh")
	if _, err := os.Stat(script); err != nil {
		return errors.New("в архиве нет install.sh")
	}
	cmd := exec.Command("/bin/sh", script)
	cmd.Dir = pkg
	out, err := cmd.CombinedOutput()
	log.Printf("update install.sh: %v\n%s", err, strings.TrimSpace(string(out)))
	if err != nil {
		return fmt.Errorf("установщик обновления завершился с ошибкой: %s", lastLine(string(out)))
	}
	return nil
}

// На Windows работающий файл нельзя перезаписать, но можно переименовать: старые файлы
// отодвигаем в *.old (их удалит следующий запуск помощника) и кладём новые на их место.
func installWindows(pkg string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dest := filepath.Dir(exe)
	entries, err := os.ReadDir(pkg)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if lower == "install.bat" || lower == "uninstall.bat" {
			continue
		}
		target := filepath.Join(dest, name)
		if _, err := os.Stat(target); err == nil {
			old := target + ".old"
			_ = os.Remove(old)
			if err := os.Rename(target, old); err != nil {
				return fmt.Errorf("не удалось заменить %s: %w", name, err)
			}
		}
		in, err := os.Open(filepath.Join(pkg, name))
		if err != nil {
			return err
		}
		err = writeFile(target, in, 0o755)
		in.Close()
		if err != nil {
			return fmt.Errorf("не удалось записать %s: %w", name, err)
		}
	}
	return nil
}

// cleanupOldFiles удаляет файлы, отодвинутые прошлым обновлением на Windows.
func cleanupOldFiles() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), "*.old"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}
