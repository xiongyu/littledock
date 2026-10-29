package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func gpuRead(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", err
	}
	if len(data) > 4096 {
		return "", io.ErrShortBuffer
	}
	return strings.TrimSpace(string(data)), nil
}

var gpuCardName = regexp.MustCompile(`^card[0-9]{1,4}$`)

// These are documented, read-only amdgpu sysfs counters; DRM card indices are
// never used as identity when multiple entries refer to the same PCI device.
func collectAMDGPU(ctx context.Context, root string) ([]gpuDTO, []string) {
	directory, err := os.Open(root)
	if err != nil {
		return []gpuDTO{}, nil
	}
	defer directory.Close()
	entries, _ := directory.ReadDir(256)
	devices := []gpuDTO{}
	unavailable := []string{}
	if len(entries) == 256 {
		unavailable = append(unavailable, "gpu:truncated")
	}
	seen := make(map[string]bool)
	sampledAt := time.Now().UnixMilli()
	for _, entry := range entries {
		if ctx.Err() != nil {
			return devices, append(unavailable, "gpu:timed-out")
		}
		if !gpuCardName.MatchString(entry.Name()) {
			continue
		}
		path, err := filepath.EvalSymlinks(filepath.Join(root, entry.Name(), "device"))
		if err != nil || seen[path] {
			continue
		}
		driver, err := filepath.EvalSymlinks(filepath.Join(path, "driver"))
		if err != nil || filepath.Base(driver) != "amdgpu" {
			continue
		}
		if len(devices) >= maxGPUs {
			return devices, append(unavailable, "gpu:truncated")
		}
		seen[path] = true
		name, _ := gpuRead(filepath.Join(path, "product_name"))
		if name == "" {
			pci, _ := gpuRead(filepath.Join(path, "device"))
			name = "AMD GPU " + pci
		}
		busy, _ := gpuRead(filepath.Join(path, "gpu_busy_percent"))
		used, _ := gpuRead(filepath.Join(path, "mem_info_vram_used"))
		total, _ := gpuRead(filepath.Join(path, "mem_info_vram_total"))
		device := gpuDTO{ID: "pci:" + boundedText(filepath.Base(path), 128), Name: boundedText(name, 256), UtilizationPercent: gpuNumber(busy, 0, 100), MemoryUsedBytes: gpuBytes(used, 1), MemoryTotalBytes: gpuBytes(total, 1), Source: "amdgpu-sysfs", SampledAt: &sampledAt}
		device.UtilizationScope = "device"
		sharedUsed, _ := gpuRead(filepath.Join(path, "mem_info_gtt_used"))
		sharedTotal, _ := gpuRead(filepath.Join(path, "mem_info_gtt_total"))
		device.SharedMemoryUsedBytes = gpuBytes(sharedUsed, 1)
		device.SharedMemoryTotalBytes = gpuBytes(sharedTotal, 1)
		if device.SharedMemoryTotalBytes != nil && *device.SharedMemoryTotalBytes == 0 {
			device.SharedMemoryTotalBytes = nil
		}
		if device.SharedMemoryUsedBytes != nil && device.SharedMemoryTotalBytes != nil && *device.SharedMemoryUsedBytes > *device.SharedMemoryTotalBytes {
			device.SharedMemoryUsedBytes = nil
		}
		if device.MemoryTotalBytes != nil && *device.MemoryTotalBytes == 0 {
			device.MemoryTotalBytes = nil
		}
		if device.MemoryUsedBytes != nil && device.MemoryTotalBytes != nil && *device.MemoryUsedBytes > *device.MemoryTotalBytes {
			device.MemoryUsedBytes = nil
		}
		if device.UtilizationPercent == nil || device.MemoryUsedBytes == nil || device.MemoryTotalBytes == nil {
			unavailable = append(unavailable, "gpu:amdgpu-partial")
		}
		devices = append(devices, device)
	}
	return devices, unavailable
}

func collectGPUPlatform(ctx context.Context) ([]gpuDTO, []string) {
	inventory, unavailable := linuxGPUInventory(ctx, "/sys/class/drm", "/sys/bus/pci/devices", "/dev/dri")
	amd, missing := collectAMDGPU(ctx, "/sys/class/drm")
	unavailable = append(unavailable, missing...)
	metrics := make(map[string]gpuDTO)
	for _, device := range amd {
		metrics[device.ID] = device
	}
	intelDevices := make(map[string]bool)
	hasNvidia := false
	for _, device := range inventory {
		if device.vendor == "0x8086" && (device.driver == "i915" || device.driver == "xe") {
			intelDevices[device.pci] = true
		}
		if device.vendor == "0x10de" {
			hasNvidia = true
		}
		if device.driver == "" || device.vendor == "0x1002" && device.driver != "amdgpu" || device.vendor == "0x8086" && device.driver != "i915" && device.driver != "xe" || device.vendor == "0x10de" && device.driver != "nvidia" {
			unavailable = append(unavailable, "gpu:driver-unavailable")
		}
	}
	if len(intelDevices) > 0 {
		// Keep a separate proc budget so a large machine cannot consume the
		// NVIDIA command's remaining 800 ms of the shared 1200 ms worker budget.
		scanContext, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		scan := scanIntelFDInfo(scanContext, "/proc", intelDevices)
		cancel()
		values, missing := linuxIntelHistory.sample(scan, time.Now())
		unavailable = append(unavailable, missing...)
		for _, device := range inventory {
			if !intelDevices[device.pci] {
				continue
			}
			gpu := device.gpu
			gpu.Source = "intel-drm-fdinfo"
			gpu.UtilizationScope = "visible-clients"
			gpu.UtilizationPercent = values[device.pci]
			if _, found := values[device.pci]; !found {
				unavailable = append(unavailable, "gpu:intel-no-visible-clients")
			}
			memory, missing := readIntelMemory(ctx, device.renderNode, device.driver)
			unavailable = append(unavailable, missing...)
			gpu.MemoryTotalBytes = memory.localTotal
			gpu.MemoryUsedBytes = memory.localUsed
			gpu.SharedMemoryUsedBytes = memory.sharedUsed
			if memory.sharedUsed == nil {
				unavailable = append(unavailable, "gpu:intel-shared-memory-unavailable")
			}
			if memory.localTotal != nil && memory.localUsed == nil && intelCanReadDeviceUsage("/proc") {
				unavailable = append(unavailable, "gpu:intel-memory-query-unavailable")
			}
			metrics[gpu.ID] = gpu
		}
	}
	var binary string
	for _, candidate := range []string{"/usr/bin/nvidia-smi", "/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			binary = candidate
			break
		}
	}
	if binary != "" && ctx.Err() == nil {
		deadline, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
		defer cancel()
		command := exec.CommandContext(deadline, binary, "--query-gpu=pci.bus_id,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits")
		output := &gpuBuffer{limit: maxGPUBytes}
		diagnostics := &gpuBuffer{limit: 4096}
		command.Stdout = output
		command.Stderr = diagnostics
		command.WaitDelay = 100 * time.Millisecond
		if err := runGPUCommand(command); err != nil {
			unavailable = append(unavailable, "gpu:nvidia-unavailable")
		} else {
			nvidia, missing := parseNvidiaLinux(output.data, time.Now().UnixMilli())
			for _, device := range nvidia {
				metrics[device.ID] = device
			}
			unavailable = append(unavailable, missing...)
		}
	} else if hasNvidia && binary == "" {
		unavailable = append(unavailable, "gpu:nvidia-tool-missing")
	}
	devices := make([]gpuDTO, 0, len(inventory))
	seen := make(map[string]bool)
	for _, device := range inventory {
		gpu := device.gpu
		if measured, found := metrics[gpu.ID]; found {
			gpu = measured
		}
		devices = append(devices, gpu)
		seen[gpu.ID] = true
	}
	for id, device := range metrics {
		if !seen[id] {
			devices = append(devices, device)
		}
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	if len(devices) == 0 {
		unavailable = append(unavailable, "gpu:no-supported-driver")
	}
	if len(devices) > maxGPUs {
		devices = devices[:maxGPUs]
		unavailable = append(unavailable, "gpu:truncated")
	}
	return devices, unavailable
}

var linuxIntelHistory intelGPUHistory

func closeGPUPlatform() { linuxIntelHistory = intelGPUHistory{} }
