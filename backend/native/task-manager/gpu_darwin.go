package main

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

var macGPUInventory struct {
	checked     time.Time
	devices     map[uint64]ioregPCIDevice
	unavailable []string
}

func runGPURegistry(ctx context.Context, timeout time.Duration, args ...string) ([]byte, string) {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(deadline, "/usr/sbin/ioreg", args...)
	command.Env = []string{"LC_ALL=C", "LANG=C", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	command.Dir = "/"
	output := &gpuBuffer{limit: maxIORegGPUBytes}
	diagnostics := &gpuBuffer{limit: 4096}
	command.Stdout = output
	command.Stderr = diagnostics
	command.WaitDelay = 50 * time.Millisecond
	if err := runGPUCommand(command); err != nil {
		if len(output.data) >= maxIORegGPUBytes {
			return nil, "gpu:ioreg-output-limit"
		}
		if deadline.Err() != nil {
			return nil, "gpu:timed-out"
		}
		message := strings.ToLower(string(diagnostics.data))
		if strings.Contains(message, "not permitted") || strings.Contains(message, "permission denied") {
			return nil, "gpu:ioreg-permission-denied"
		}
		return nil, "gpu:ioreg-unavailable"
	}
	return output.data, ""
}

func collectGPUPlatform(ctx context.Context) ([]gpuDTO, []string) {
	// Without -l, only matching accelerators include all properties. -t keeps
	// ancestor IDs/classes for exact PCI-parent joins, not model-name guesses.
	data, reason := runGPURegistry(ctx, 700*time.Millisecond, "-a", "-r", "-t", "-d", "1", "-c", "IOAccelerator")
	if reason != "" {
		return []gpuDTO{}, []string{reason}
	}
	sampledAt := time.Now().UnixMilli()
	if macGPUInventory.checked.IsZero() || time.Since(macGPUInventory.checked) >= 30*time.Second {
		macGPUInventory.checked = time.Now()
		inventory, inventoryReason := runGPURegistry(ctx, 400*time.Millisecond, "-a", "-r", "-d", "1", "-c", "IOPCIDevice")
		if inventoryReason != "" {
			macGPUInventory.unavailable = []string{"gpu:ioreg-inventory-unavailable"}
		} else {
			macGPUInventory.devices, macGPUInventory.unavailable = parseIORegPCIInventory(inventory)
		}
	}
	devices, unavailable := parseIORegGPU(data, macGPUInventory.devices, sampledAt)
	unavailable = append(unavailable, macGPUInventory.unavailable...)
	return devices, boundedUnavailable(unavailable)
}

func closeGPUPlatform() {
	macGPUInventory.devices = nil
	macGPUInventory.unavailable = nil
	macGPUInventory.checked = time.Time{}
}
