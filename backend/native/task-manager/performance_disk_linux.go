package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func readDiskText(path string, limit int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > limit {
		return "", io.ErrShortBuffer
	}
	return strings.TrimSpace(string(data)), nil
}
func gatherDiskCounters(ctx context.Context) ([]diskCounter, []string) {
	result := []diskCounter{}
	unavailable := []string{}
	folder, err := os.Open("/sys/block")
	if err != nil {
		return result, []string{"disks"}
	}
	entries, err := folder.ReadDir(4097)
	_ = folder.Close()
	if err != nil && err != io.EOF {
		return result, []string{"disks"}
	}
	if len(entries) > 4096 {
		entries = entries[:4096]
		unavailable = append(unavailable, "disks:truncated")
	}
	// Show actual device names. File-backed loop/RAM devices are independent
	// block devices, but must not crowd physical/virtual disks out of the limit.
	virtual := func(name string) bool { return strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") }
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i].Name(), entries[j].Name()
		if virtual(a) != virtual(b) {
			return !virtual(a)
		}
		return a < b
	})
	for _, entry := range entries {
		if len(result) >= maxDisks {
			unavailable = append(unavailable, "disks:truncated")
			break
		}
		if ctx.Err() != nil {
			unavailable = append(unavailable, "disks:partial")
			break
		}
		name := entry.Name()
		text, readErr := readDiskText(filepath.Join("/sys/block", name, "stat"), 4096)
		row, valid := linuxDiskCounter(name, text, time.Now())
		if readErr != nil || !valid {
			unavailable = append(unavailable, "disks:io-unavailable")
		}
		if size, sizeErr := readDiskText(filepath.Join("/sys/block", name, "size"), 64); sizeErr == nil {
			if sectors, parseErr := strconv.ParseUint(size, 10, 64); parseErr == nil && sectors <= maxSafeNumber/512 {
				total := sectors * 512
				row.TotalBytes = &total
			}
		}
		result = append(result, row)
	}
	return result, unavailable
}
