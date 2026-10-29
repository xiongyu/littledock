package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/sys/unix"
)

func platformProcesses(ctx context.Context) ([]int32, map[int32]*processMetadata, error) {
	pids, err := process.PidsWithContext(ctx)
	return pids, nil, err
}
func platformDetails(ctx context.Context, p *process.Process, d *detailsDTO) {
	folder, err := os.Open(fmt.Sprintf("/proc/%d/fd", p.Pid))
	if err != nil {
		d.Unavailable = append(d.Unavailable, "files")
	} else {
		entries, e := folder.ReadDir(maxDetails + 1)
		_ = folder.Close()
		if e != nil && e != io.EOF {
			d.Unavailable = append(d.Unavailable, "files")
		}
		if len(entries) > maxDetails {
			entries = entries[:maxDetails]
			d.Unavailable = append(d.Unavailable, "files:truncated")
		}
		for _, entry := range entries {
			fd, e := strconv.ParseUint(entry.Name(), 10, 64)
			if e != nil {
				continue
			}
			path, e := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", p.Pid, entry.Name()))
			if e != nil {
				continue
			}
			kind := "file"
			if strings.HasPrefix(path, "socket:") {
				kind = "socket"
			}
			if strings.HasPrefix(path, "pipe:") {
				kind = "pipe"
			}
			if strings.HasPrefix(path, "anon_inode:") {
				kind = "anonymous"
			}
			d.Files = append(d.Files, fileDTO{fd, bounded(path), kind})
		}
	}
	maps, err := os.Open(fmt.Sprintf("/proc/%d/maps", p.Pid))
	if err != nil {
		d.Unavailable = append(d.Unavailable, "modules")
	} else {
		defer maps.Close()
		limited := &io.LimitedReader{R: maps, N: 1024 * 1024}
		scanner := bufio.NewScanner(limited)
		scanner.Buffer(make([]byte, 4096), 16384)
		seen := make(map[string]bool)
		for scanner.Scan() {
			if ctx.Err() != nil {
				d.Unavailable = append(d.Unavailable, "modules:truncated")
				break
			}
			line := scanner.Text()
			index := strings.Index(line, "/")
			if index < 0 {
				continue
			}
			path := bounded(line[index:])
			if seen[path] {
				continue
			}
			seen[path] = true
			if len(d.Modules) >= maxDetails {
				d.Unavailable = append(d.Unavailable, "modules:truncated")
				break
			}
			d.Modules = append(d.Modules, path)
		}
		if scanner.Err() != nil || limited.N == 0 {
			d.Unavailable = append(d.Unavailable, "modules:truncated")
		}
	}
	tasks, err := os.Open(fmt.Sprintf("/proc/%d/task", p.Pid))
	if err != nil {
		d.Unavailable = append(d.Unavailable, "threads")
	} else {
		entries, e := tasks.ReadDir(maxDetails + 1)
		_ = tasks.Close()
		if e != nil && e != io.EOF {
			d.Unavailable = append(d.Unavailable, "threads")
		}
		if len(entries) > maxDetails {
			entries = entries[:maxDetails]
			d.Unavailable = append(d.Unavailable, "threads:truncated")
		}
		for _, entry := range entries {
			if ctx.Err() != nil {
				d.Unavailable = append(d.Unavailable, "threads:truncated")
				break
			}
			id, e := strconv.ParseInt(entry.Name(), 10, 32)
			if e != nil {
				continue
			}
			thread := threadDTO{ID: int32(id)}
			stat, e := os.Open(fmt.Sprintf("/proc/%d/task/%s/stat", p.Pid, entry.Name()))
			if e == nil {
				data, _ := io.ReadAll(io.LimitReader(stat, 4096))
				_ = stat.Close()
				text := string(data)
				end := strings.LastIndex(text, ") ")
				if end >= 0 && len(text) > end+2 {
					thread.State = text[end+2 : end+3]
				}
			}
			d.Threads = append(d.Threads, thread)
		}
	}
}
func terminatePlatform(ctx context.Context, p *process.Process, identity identityParams, force bool) error {
	// pidfd binds the action to the opened process instead of a reusable PID.
	// On older kernels without pidfd, do not silently weaken this protection.
	fd, err := unix.PidfdOpen(int(p.Pid), 0)
	if err != nil {
		return fail("UNSUPPORTED", "Safe termination requires Linux pidfd support (kernel 5.3 or newer)")
	}
	defer unix.Close(fd)
	if _, err = checkIdentity(ctx, identity); err != nil {
		return err
	}
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	if err = unix.PidfdSendSignal(fd, signal, nil, 0); err != nil {
		return fail("PERMISSION_DENIED", "Process could not be terminated with current permissions")
	}
	return nil
}
