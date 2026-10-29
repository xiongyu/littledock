package main

import (
	"context"
	"fmt"
	"github.com/shirou/gopsutil/v4/process"
	"io"
	"os"
	"strings"
)

func platformCommandLine(ctx context.Context, p *process.Process) (string, bool, error) {
	if ctx.Err() != nil {
		return "", false, ctx.Err()
	}
	file, err := os.Open(fmt.Sprintf("/proc/%d/cmdline", p.Pid))
	if err != nil {
		return "", false, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxCommandLine+1))
	if err != nil {
		return "", false, err
	}
	truncated := len(data) > maxCommandLine
	if truncated {
		data = data[:maxCommandLine]
	}
	raw := strings.TrimSuffix(string(data), "\x00")
	if raw == "" {
		return "", truncated, nil
	}
	return displayArguments(strings.Split(raw, "\x00")), truncated, nil
}
