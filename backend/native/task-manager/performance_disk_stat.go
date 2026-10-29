package main

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// Keep the kernel counter decoder platform-independent so all build hosts can
// exercise sector units, malformed input and overflow without a real server.
func linuxDiskCounter(name, text string, now time.Time) (diskCounter, bool) {
	result := diskCounter{ID: name, Name: name, SampledAt: now}
	fields := strings.Fields(text)
	if len(fields) < 11 {
		return result, false
	}
	read, err := strconv.ParseUint(fields[2], 10, 64)
	if err != nil || read > math.MaxUint64/512 {
		return result, false
	}
	write, err := strconv.ParseUint(fields[6], 10, 64)
	if err != nil || write > math.MaxUint64/512 {
		return result, false
	}
	busy, err := strconv.ParseUint(fields[9], 10, 64)
	if err != nil {
		return result, false
	}
	result.ReadBytes = read * 512
	result.WriteBytes = write * 512
	result.BusyMillis = &busy
	result.IOAvailable = true
	return result, true
}
