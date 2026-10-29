package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestWindowsGPUCounterIdentityBusiestEngineAndFirstSample(t *testing.T) {
	total := uint64(8 * 1024 * 1024 * 1024)
	adapters := []gpuAdapter{{"00000000:00000abc", "Real adapter name", &total, &total}, {"00000000:00000def", "Integrated adapter", nil, &total}}
	engines := []gpuCounterValue{
		{"pid_10_luid_0x00000000_0x00000ABC_phys_0_eng_0_engtype_3D", 40},
		{"pid_20_luid_0x00000000_0x00000abc_phys_0_eng_0_engtype_3D", 30},
		{"pid_10_luid_0x00000000_0x00000abc_phys_0_eng_1_engtype_Copy", 60},
		{"pid_1_luid_0x00000000_0x0000ffff_phys_0_eng_0_engtype_3D", 99},
	}
	memory := []gpuCounterValue{{"luid_0x00000000_0x00000abc_phys_0", 1024 * 1024 * 1024}}
	sharedMemory := []gpuCounterValue{{"luid_0x00000000_0x00000def_phys_0", 256 * 1024 * 1024}}
	first, _ := combineGPUCounters(adapters, engines, memory, sharedMemory, false, 1)
	if first[0].UtilizationPercent != nil {
		t.Fatal("first delta must be unknown")
	}
	devices, _ := combineGPUCounters(adapters, engines, memory, sharedMemory, true, 2)
	if devices[1].SharedMemoryUsedBytes == nil || *devices[1].SharedMemoryUsedBytes != 256*1024*1024 || devices[1].SharedMemoryTotalBytes == nil || *devices[1].SharedMemoryTotalBytes != total || devices[1].UtilizationScope != "device" {
		t.Fatal("integrated GPU shared system memory was omitted or confused with dedicated memory")
	}
	if len(devices) != 2 || *devices[0].UtilizationPercent != 70 || devices[0].Name != "Real adapter name" || devices[1].UtilizationPercent != nil || devices[1].MemoryTotalBytes != nil || *devices[0].MemoryUsedBytes != 1024*1024*1024 {
		t.Fatalf("wrong adapter/engine aggregation: %+v", devices)
	}
	if luid, physical, valid := gpuInstanceIdentity("pid_1_luid_0x0_0xABC_phys_2_eng_0_engtype_3D"); !valid || luid != "00000000:00000abc" || physical != "2" {
		t.Fatal("LUID normalization failed")
	}
}

func TestWindowsGPUVendorsAndSharedMemoryUseStableIdentities(t *testing.T) {
	total := uint64(8 << 30)
	adapters := []gpuAdapter{
		{"00000000:00000001", "Intel Arc", &total, &total},
		{"00000000:00000002", "Intel Graphics", nil, &total},
		{"00000000:00000003", "NVIDIA GeForce", &total, &total},
		{"00000000:00000004", "AMD Radeon", &total, &total},
	}
	engines := []gpuCounterValue{
		{"pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D", 50},
		{"pid_1_luid_0x0_0x2_phys_0_eng_0_engtype_3D", 0},
		{"pid_1_luid_0x0_0x3_phys_0_eng_0_engtype_Compute", 70},
		{"pid_1_luid_0x0_0x4_phys_0_eng_1_engtype_Compute", 25},
	}
	shared := []gpuCounterValue{{"luid_0x0_0x1_phys_0", 0}, {"luid_0x0_0x2_phys_0", 1 << 30}, {"luid_0x0_0x3_phys_0", 9 << 30}}
	devices, _ := combineGPUCounters(adapters, engines, nil, shared, true, 12)
	for i, expected := range []float64{50, 0, 70, 25} {
		if devices[i].UtilizationPercent == nil || *devices[i].UtilizationPercent != expected {
			t.Fatalf("vendor %d lost utilization", i)
		}
	}
	if devices[0].SharedMemoryUsedBytes == nil || *devices[0].SharedMemoryUsedBytes != 0 || devices[2].SharedMemoryUsedBytes != nil || devices[3].SharedMemoryUsedBytes != nil {
		t.Fatal("zero, invalid, and absent shared memory were conflated")
	}
}

func TestWindowsGPUIncludesReservedDedicatedSystemMemory(t *testing.T) {
	for _, sample := range []struct{ video, system, expected uintptr }{{0, 128 << 20, 128 << 20}, {8 << 30, 128 << 20, (8 << 30) + (128 << 20)}, {0, 0, 0}} {
		value := gpuDedicatedCapacity(gpuDXGIDesc{DedicatedVideoMemory: sample.video, DedicatedSystemMemory: sample.system})
		if value == nil || *value != uint64(sample.expected) {
			t.Fatalf("wrong dedicated GPU reservation: %v", value)
		}
	}
	if gpuDedicatedCapacity(gpuDXGIDesc{DedicatedVideoMemory: uintptr(maxSafeNumber), DedicatedSystemMemory: 1}) != nil {
		t.Fatal("unsafe combined capacity accepted")
	}
}

func TestWindowsGPUActualNativeReadIsBoundedAndReportsSources(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	started := time.Now()
	first, unavailable := gatherGPU(ctx)
	if time.Since(started) > 1500*time.Millisecond {
		t.Fatal("native GPU read exceeded deadline")
	}
	// Other collector tests may already have primed the shared provider. The
	// pure aggregation test above separately verifies a fresh first interval.
	if len(first) > maxGPUs {
		t.Fatal("native GPU list exceeded bound")
	}
	time.Sleep(1100 * time.Millisecond)
	started = time.Now()
	devices, missing := gatherGPU(ctx)
	if time.Since(started) > 1500*time.Millisecond || len(devices) > maxGPUs {
		t.Fatal("native GPU sampling exceeded bounds")
	}
	for _, device := range devices {
		if device.ID == "" || device.Name == "" || (device.Source != "windows-pdh-dxgi" && device.Source != "nvidia-smi-compute") {
			t.Fatal("native adapter identity missing")
		}
		if value := device.UtilizationPercent; value != nil && (*value < 0 || *value > 100) {
			t.Fatal("invalid native utilization")
		}
	}
	encoded, err := json.Marshal(devices)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("native Windows GPU sample %s; first unavailable=%v; unavailable=%v; final latency=%s", encoded, unavailable, missing, time.Since(started))
}
