//go:build linux

package main

import (
	"context"
	"encoding/csv"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type linuxGPUDevice struct {
	pci, vendor, driver, path, renderNode string
	gpu                                   gpuDTO
}

var gpuRenderName = regexp.MustCompile(`^renderD[0-9]{1,5}$`)

// PCI inventory is independent of vendor utilities and counter permissions.
// A missing driver must not make a present Intel/AMD/NVIDIA adapter disappear.
func linuxGPUInventory(ctx context.Context, drmRoot, pciRoot, devRoot string) ([]linuxGPUDevice, []string) {
	devices := make(map[string]linuxGPUDevice)
	missing := []string{}
	sampled := time.Now().UnixMilli()
	add := func(path, render string) {
		pci := normalizeGPUPCI(filepath.Base(path))
		if pci == "" {
			return
		}
		if current, ok := devices[pci]; ok {
			if render != "" {
				current.renderNode = render
				devices[pci] = current
			}
			return
		}
		if len(devices) >= maxGPUs {
			missing = append(missing, "gpu:truncated")
			return
		}
		vendor, _ := gpuRead(filepath.Join(path, "vendor"))
		vendor = strings.ToLower(vendor)
		driverPath, _ := filepath.EvalSymlinks(filepath.Join(path, "driver"))
		driver := filepath.Base(driverPath)
		if driver == "." {
			driver = ""
		}
		if vendor == "" {
			switch driver {
			case "amdgpu", "radeon":
				vendor = "0x1002"
			case "i915", "xe":
				vendor = "0x8086"
			case "nvidia", "nouveau":
				vendor = "0x10de"
			}
		}
		brand := ""
		switch vendor {
		case "0x8086":
			brand = "Intel"
		case "0x1002":
			brand = "AMD"
		case "0x10de":
			brand = "NVIDIA"
		default:
			return
		}
		name, _ := gpuRead(filepath.Join(path, "product_name"))
		if name == "" {
			device, _ := gpuRead(filepath.Join(path, "device"))
			name = brand + " GPU"
			if device != "" {
				name += " " + device
			}
		}
		devices[pci] = linuxGPUDevice{pci: pci, vendor: vendor, driver: driver, path: path, renderNode: render, gpu: gpuDTO{ID: "pci:" + pci, Name: boundedText(name, 256), Source: "linux-pci", SampledAt: &sampled}}
	}
	read := func(root string, limit int) []os.DirEntry {
		directory, err := os.Open(root)
		if err != nil {
			return nil
		}
		defer directory.Close()
		entries, _ := directory.ReadDir(limit)
		if len(entries) == limit {
			missing = append(missing, "gpu:truncated")
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		return entries
	}
	for _, entry := range read(drmRoot, 512) {
		if ctx.Err() != nil {
			break
		}
		name := entry.Name()
		if !gpuCardName.MatchString(name) && !gpuRenderName.MatchString(name) {
			continue
		}
		path, err := filepath.EvalSymlinks(filepath.Join(drmRoot, name, "device"))
		if err != nil {
			continue
		}
		render := ""
		if gpuRenderName.MatchString(name) {
			render = filepath.Join(devRoot, name)
		}
		add(path, render)
	}
	for _, entry := range read(pciRoot, 4096) {
		if ctx.Err() != nil {
			break
		}
		if normalizeGPUPCI(entry.Name()) == "" {
			continue
		}
		path := filepath.Join(pciRoot, entry.Name())
		class, _ := gpuRead(filepath.Join(path, "class"))
		number, err := strconv.ParseUint(strings.TrimPrefix(class, "0x"), 16, 32)
		if err != nil || number>>16 != 3 {
			continue
		}
		add(path, "")
	}
	result := make([]linuxGPUDevice, 0, len(devices))
	for _, device := range devices {
		result = append(result, device)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].pci < result[j].pci })
	return result, missing
}

func parseNvidiaLinux(data []byte, sampledAt int64) ([]gpuDTO, []string) {
	if len(data) > maxGPUBytes {
		return []gpuDTO{}, []string{"gpu:nvidia-output-limit"}
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	reader.FieldsPerRecord = 7
	reader.TrimLeadingSpace = true
	devices := []gpuDTO{}
	missing := []string{}
	seen := make(map[string]bool)
	for len(devices) < maxGPUs {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return devices, append(missing, "gpu:nvidia-invalid")
		}
		pci := normalizeGPUPCI(row[0])
		if pci == "" || seen[pci] {
			missing = append(missing, "gpu:nvidia-invalid")
			continue
		}
		seen[pci] = true
		var encoded strings.Builder
		writer := csv.NewWriter(&encoded)
		if err := writer.Write(row[1:]); err != nil {
			continue
		}
		writer.Flush()
		parsed, reasons := parseNvidiaGPU([]byte(encoded.String()), sampledAt)
		missing = append(missing, reasons...)
		if len(parsed) == 1 {
			parsed[0].ID = "pci:" + pci
			parsed[0].UtilizationScope = "device"
			devices = append(devices, parsed[0])
		}
	}
	if _, err := reader.Read(); err != io.EOF {
		missing = append(missing, "gpu:truncated")
	}
	return devices, missing
}
