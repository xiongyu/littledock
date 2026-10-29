package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAMDGPUReadsRealSysfsUnitsAndStableDeviceIdentity(t *testing.T) {
	root := t.TempDir()
	card := filepath.Join(root, "card9")
	device := filepath.Join(root, "devices", "0000:0a:00.0")
	driver := filepath.Join(root, "drivers", "amdgpu")
	for _, path := range []string{card, device, driver} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(device, filepath.Join(card, "device")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driver, filepath.Join(device, "driver")); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"gpu_busy_percent": "23", "mem_info_vram_used": "1073741824", "mem_info_vram_total": "8589934592", "mem_info_gtt_used": "536870912", "mem_info_gtt_total": "17179869184", "product_name": "AMD fixture"} {
		if err := os.WriteFile(filepath.Join(device, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	devices, unavailable := collectAMDGPU(context.Background(), root)
	if len(devices) != 1 || devices[0].SharedMemoryUsedBytes == nil || *devices[0].SharedMemoryUsedBytes != 536870912 || devices[0].SharedMemoryTotalBytes == nil || *devices[0].SharedMemoryTotalBytes != 17179869184 {
		t.Fatal("AMD shared GTT was omitted or merged into dedicated memory")
	}
	if len(devices) != 1 || len(unavailable) != 0 || devices[0].ID != "pci:0000:0a:00.0" || *devices[0].UtilizationPercent != 23 || *devices[0].MemoryUsedBytes != 1073741824 || *devices[0].MemoryTotalBytes != 8589934592 {
		t.Fatalf("wrong sysfs data %+v %v", devices, unavailable)
	}
	if err := os.WriteFile(filepath.Join(device, "gpu_busy_percent"), []byte("not available"), 0600); err != nil {
		t.Fatal(err)
	}
	devices, unavailable = collectAMDGPU(context.Background(), root)
	if devices[0].UtilizationPercent != nil || len(unavailable) == 0 {
		t.Fatal("unavailable sysfs data fabricated")
	}
}

func TestLinuxGPUInventoryKeepsIntelDiscreteIntegratedAndDriverlessNvidia(t *testing.T) {
	root := t.TempDir()
	pciRoot := filepath.Join(root, "pci")
	drmRoot := filepath.Join(root, "drm")
	devRoot := filepath.Join(root, "dev")
	for _, path := range []string{pciRoot, drmRoot, devRoot} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct{ pci, vendor, driver, device, card, render string }{{"0000:00:02.0", "0x8086", "i915", "0x3e92", "card1", "renderD128"}, {"0000:03:00.0", "0x8086", "xe", "0x56a0", "card2", "renderD129"}, {"0000:05:00.0", "0x10de", "", "0x1e84", "", ""}, {"0000:06:00.0", "0x1002", "radeon", "0x67df", "", ""}} {
		path := filepath.Join(pciRoot, row.pci)
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		for key, value := range map[string]string{"vendor": row.vendor, "device": row.device, "class": "0x030000"} {
			if err := os.WriteFile(filepath.Join(path, key), []byte(value), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if row.driver != "" {
			driver := filepath.Join(root, "drivers", row.driver)
			if err := os.MkdirAll(driver, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(driver, filepath.Join(path, "driver")); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range []string{row.card, row.render} {
			if name == "" {
				continue
			}
			directory := filepath.Join(drmRoot, name)
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(path, filepath.Join(directory, "device")); err != nil {
				t.Fatal(err)
			}
		}
	}
	devices, missing := linuxGPUInventory(context.Background(), drmRoot, pciRoot, devRoot)
	if len(devices) != 4 || len(missing) != 0 {
		t.Fatalf("bad inventory %+v %v", devices, missing)
	}
	if devices[0].driver != "i915" || devices[1].driver != "xe" || devices[0].renderNode != filepath.Join(devRoot, "renderD128") || devices[1].renderNode != filepath.Join(devRoot, "renderD129") {
		t.Fatal("Intel devices or render nodes misidentified")
	}
	if devices[2].gpu.Source != "linux-pci" || !strings.Contains(devices[2].gpu.Name, "NVIDIA") || devices[2].gpu.UtilizationPercent != nil {
		t.Fatal("driverless GPU hidden or fabricated")
	}
	if devices[3].driver != "radeon" {
		t.Fatal("legacy AMD inventory lost")
	}
}

func TestLinuxNvidiaPCIParsingBindsCountersWithoutModelNameGuessing(t *testing.T) {
	data := []byte("00000000:03:00.0, GPU-a, Same Model, 50, 1024, 8192, 40\n00000000:04:00.0, GPU-b, Same Model, N/A, 2048, 8192, N/A\n")
	devices, _ := parseNvidiaLinux(data, 123)
	if len(devices) != 2 || devices[0].ID != "pci:0000:03:00.0" || devices[1].ID != "pci:0000:04:00.0" || devices[0].UtilizationPercent == nil || *devices[0].UtilizationPercent != 50 || devices[1].UtilizationPercent != nil || *devices[1].MemoryUsedBytes != 2048*1024*1024 {
		t.Fatalf("wrong bound counters %+v", devices)
	}
	devices, reasons := parseNvidiaLinux([]byte("invalid, GPU-a, Model, 0, 0, 1, 0\n"), 1)
	if len(devices) != 0 || !intelHas(reasons, "gpu:nvidia-invalid") {
		t.Fatal("invalid identity accepted")
	}
}

func TestIntelMemoryPrivilegesRejectContainerOnlyCapabilities(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "self"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, "self", name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("uid_map", "0 0 4294967295\n")
	write("status", "CapEff:\t0000004000000000\n")
	if !intelCanReadDeviceUsage(root) {
		t.Fatal("real perfmon capability denied")
	}
	write("status", "CapEff:\t0000000000200000\n")
	if !intelCanReadDeviceUsage(root) {
		t.Fatal("real admin capability denied")
	}
	write("uid_map", "0 100000 65536\n")
	if intelCanReadDeviceUsage(root) {
		t.Fatal("nested namespace capability mistaken for device privilege")
	}
	write("uid_map", "0 0 4294967295\n")
	write("status", "CapEff:\t0000000000000000\n")
	if intelCanReadDeviceUsage(root) {
		t.Fatal("missing capability invented")
	}
	memory, reason := readIntelMemory(context.Background(), filepath.Join(root, "missing"), "xe")
	if memory.localUsed != nil || !intelHas(reason, "gpu:intel-render-node-unavailable") {
		t.Fatal("missing render node fabricated")
	}
}
