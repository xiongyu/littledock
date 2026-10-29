//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func configureGPUTestCommand(_ *exec.Cmd) {}

func gpuTestProcessAlive(pid int) bool {
	if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		return false
	}
	// An orphan killed by Pdeathsig may briefly await init's reap. It has
	// already stopped executing and cannot retain the GPU driver workload.
	if stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat")); err == nil {
		if end := strings.LastIndex(string(stat), ")"); end >= 0 && strings.HasPrefix(string(stat[end+1:]), " Z ") {
			return false
		}
	}
	return true
}
