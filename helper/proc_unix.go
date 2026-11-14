//go:build !windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func hideWindow(cmd *exec.Cmd) {}

func terminate(p *os.Process) { _ = p.Signal(syscall.SIGTERM) }

func isCoreProcess(pid int) bool {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	name := string(out)
	return err == nil && (strings.Contains(name, "sing-box") || strings.Contains(name, "xray"))
}
