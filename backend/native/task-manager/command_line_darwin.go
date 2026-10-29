package main

import (
	"context"
	"github.com/shirou/gopsutil/v4/process"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func platformCommandLine(ctx context.Context, p *process.Process) (string, bool, error) {
	// ps supplies only argv, avoiding ambiguous KERN_PROCARGS2 argv/env boundaries.
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, "/bin/ps", "-ww", "-p", strconv.Itoa(int(p.Pid)), "-o", "command=")
	command.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin"}
	command.WaitDelay = 200 * time.Millisecond
	output := &commandLineBuffer{}
	command.Stdout = output
	command.Stderr = io.Discard
	if err := runGPUCommand(command); err != nil {
		return "", false, err
	}
	return strings.TrimSuffix(string(output.data), "\n"), output.truncated, nil
}
