package main

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNvidiaGPUUsesUUIDActualUnitsAndNullUnknowns(t *testing.T) {
	data := []byte("GPU-123, NVIDIA Test, 37, 1024, 8192, 64\nGPU-456, \"NVIDIA, Other\", N/A, N/A, 16384, [Not Supported]\n")
	devices, unavailable := parseNvidiaGPU(data, 123456)
	if len(devices) != 2 || len(unavailable) == 0 {
		t.Fatalf("unexpected devices %v / %v", devices, unavailable)
	}
	if devices[0].ID != "nvidia:GPU-123" || *devices[0].UtilizationPercent != 37 || *devices[0].MemoryUsedBytes != 1024*1024*1024 || *devices[0].MemoryTotalBytes != 8192*1024*1024 || *devices[0].TemperatureCelsius != 64 || *devices[0].SampledAt != 123456 {
		t.Fatalf("incorrect reading %+v", devices[0])
	}
	if devices[1].UtilizationPercent != nil || devices[1].MemoryUsedBytes != nil || devices[1].TemperatureCelsius != nil || devices[1].Name != "NVIDIA, Other" {
		t.Fatalf("unsupported reading was fabricated: %+v", devices[1])
	}
	for _, value := range []string{"N/A", "NaN", "Inf", "-1", "101", ""} {
		if gpuNumber(value, 0, 100) != nil {
			t.Fatalf("accepted %q", value)
		}
	}
	if gpuBytes("9007199254740992", 1) != nil {
		t.Fatal("accepted unsafe integer")
	}
}

func TestGPUHungProviderDoesNotQueueWorkersOrRewriteSampleTime(t *testing.T) {
	blocked := make(chan struct{})
	cleaned := make(chan struct{})
	var calls atomic.Int32
	timestamp := time.Now().Add(-11 * time.Second).UnixMilli()
	used := uint64(123)
	busy := 50.0
	sampler := &gpuSampler{requests: make(chan gpuRequest), stop: make(chan struct{}), last: gpuSample{devices: []gpuDTO{{ID: "fixture", Name: "Fixture", Source: "test", MemoryUsedBytes: &used, UtilizationPercent: &busy, SampledAt: &timestamp}}}, collect: func(context.Context) ([]gpuDTO, []string) { calls.Add(1); <-blocked; return []gpuDTO{}, nil }, cleanup: func() { close(cleaned) }}
	for i := 0; i < 4; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		start := time.Now()
		devices, missing := sampler.sample(ctx)
		cancel()
		if time.Since(start) > 200*time.Millisecond || len(missing) == 0 || len(devices) != 1 || devices[0].MemoryUsedBytes != nil || devices[0].UtilizationPercent != nil || *devices[0].SampledAt != timestamp {
			t.Fatal("hung provider was unbounded or stale data relabelled")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("more than one blocked provider worker created")
	}
	close(sampler.stop)
	close(blocked)
	select {
	case <-cleaned:
	case <-time.After(time.Second):
		t.Fatal("GPU provider not released")
	}
}

func TestGPUDriverOutputAndIdentitiesAreBounded(t *testing.T) {
	devices, unavailable := parseNvidiaGPU([]byte(strings.Repeat("x", maxGPUBytes+1)), 1)
	if len(devices) != 0 || len(unavailable) != 1 {
		t.Fatal("oversized driver output accepted")
	}
	devices, unavailable = parseNvidiaGPU([]byte("GPU-1, Test, 1, 999, 10, 10\nGPU-1, Duplicate, 1, 1, 10, 10\n"), 1)
	if len(devices) != 1 || devices[0].MemoryUsedBytes != nil || len(unavailable) < 2 {
		t.Fatalf("bad memory/duplicate accepted %+v %v", devices, unavailable)
	}
	buffer := &gpuBuffer{limit: 3}
	if count, err := buffer.Write([]byte("abcdef")); count != 3 || err == nil || string(buffer.data) != "abc" {
		t.Fatal("driver byte cap failed")
	}
}
