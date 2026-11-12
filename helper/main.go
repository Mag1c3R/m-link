// M-Link helper: native messaging host для расширения.
// Запускает sing-box с конфигом от расширения, следит за процессом и меряет задержку узлов.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

const version = "0.1.0"

type request struct {
	ID        int             `json:"id"`
	Cmd       string          `json:"cmd"`
	Config    json.RawMessage `json:"config"`
	Port      int             `json:"port"`
	Nodes     []testNode      `json:"nodes"`
	URL       string          `json:"url"`
	TimeoutMs int             `json:"timeoutMs"`
}

type testNode struct {
	ID       string         `json:"id"`
	Outbound map[string]any `json:"outbound"`
	Server   string         `json:"server"`
	Port     int            `json:"port"`
}

var (
	outMu   sync.Mutex
	dataDir string
	core    = &coreProcess{}
)

// send пишет сообщение в формате native messaging: 4 байта длины (LE) + JSON.
func send(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	os.Stdout.Write(hdr[:])
	os.Stdout.Write(b)
}

func readMessage(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > 64<<20 {
		return nil, errors.New("message too large")
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	return buf, err
}

func reply(id int, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["id"] = id
	fields["ok"] = true
	send(fields)
}

func fail(id int, err error) {
	send(map[string]any{"id": id, "ok": false, "error": err.Error()})
}

func handle(req request) {
	switch req.Cmd {
	case "hello":
		info := map[string]any{"version": version}
		if path, err := findCore(); err != nil {
			info["coreError"] = err.Error()
		} else {
			info["corePath"] = path
			info["coreVersion"] = coreVersion(path)
		}
		reply(req.ID, info)

	case "start":
		if len(req.Config) == 0 || req.Port == 0 {
			fail(req.ID, errors.New("нет конфига или порта"))
			return
		}
		path, err := findCore()
		if err != nil {
			fail(req.ID, err)
			return
		}
		if err := core.start(path, req.Config, req.Port); err != nil {
			fail(req.ID, err)
			return
		}
		reply(req.ID, map[string]any{"coreVersion": coreVersion(path)})

	case "stop":
		core.stop()
		reply(req.ID, nil)

	case "status":
		reply(req.ID, map[string]any{"running": core.running()})

	case "test":
		results, method := latencyTest(req.Nodes, req.URL, req.TimeoutMs)
		reply(req.ID, map[string]any{"results": results, "method": method})

	default:
		fail(req.ID, fmt.Errorf("неизвестная команда %q", req.Cmd))
	}
}

func setupLogging() {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	dataDir = filepath.Join(base, "MClient")
	_ = os.MkdirAll(dataDir, 0o700)
	logPath := filepath.Join(dataDir, "helper.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 1<<20 {
		_ = os.Remove(logPath)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err == nil {
		log.SetOutput(f)
	} else {
		log.SetOutput(io.Discard)
	}
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("m-client-helper", version)
		return
	}
	setupLogging()
	log.Printf("helper %s started, args=%v", version, os.Args[1:])

	in := bufio.NewReader(os.Stdin)
	for {
		raw, err := readMessage(in)
		if err != nil {
			// Браузер закрыл соединение: гасим ядро и выходим.
			log.Printf("stdin closed: %v", err)
			core.stop()
			return
		}
		var req request
		if err := json.Unmarshal(raw, &req); err != nil {
			log.Printf("bad message: %v", err)
			continue
		}
		go handle(req)
	}
}
