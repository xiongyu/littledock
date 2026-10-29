package main

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

func numberNear(t *testing.T, actual *float64, expected float64) {
	t.Helper()
	if actual == nil || math.Abs(*actual-expected) > 0.011 {
		t.Fatalf("expected %.3f, got %v", expected, actual)
	}
}
func uint64Pointer(value uint64) *uint64 { return &value }
func hasUnavailable(codes []string, expected string) bool {
	for _, code := range codes {
		if code == expected {
			return true
		}
	}
	return false
}

func TestCPUUsagePlatformCountersAndResets(t *testing.T) {
	previous := cpu.TimesStat{User: 10, System: 10, Idle: 80}
	current := cpu.TimesStat{User: 20, System: 20, Idle: 160, Guest: 8, GuestNice: 4, Irq: 7}
	numberNear(t, cpuUsage(previous, current, "windows"), 20)
	current.Irq = 0
	numberNear(t, cpuUsage(previous, current, "linux"), 20)
	current.Nice = 10
	numberNear(t, cpuUsage(previous, current, "darwin"), 27.27)
	for _, invalid := range []cpu.TimesStat{{User: 9, System: 20, Idle: 160}, {User: 20, System: 20, Idle: 79}, {User: math.NaN(), System: 20, Idle: 160}, {User: math.Inf(1), System: 20, Idle: 160}, previous} {
		if cpuUsage(previous, invalid, "linux") != nil {
			t.Fatal("counter reset/invalid/no interval must be unavailable")
		}
	}
}
func TestLogicalCPUIdentityTopologyAndLimits(t *testing.T) {
	c := &collector{cpuCount: 2}
	first := []cpu.TimesStat{{CPU: "cpu8", User: 25, System: 25, Idle: 50}, {CPU: "cpu2", User: 10, System: 10, Idle: 80}}
	rows, codes := c.sampleLogicalCPUs(first)
	if len(rows) != 2 || rows[0].ID != 2 || rows[1].ID != 8 || rows[0].UsagePercent != nil || rows[1].UsagePercent != nil || len(codes) != 0 {
		t.Fatal("logical IDs or first sample invalid")
	}
	rows, _ = c.sampleLogicalCPUs([]cpu.TimesStat{{CPU: "cpu2", User: 20, System: 20, Idle: 160}, {CPU: "cpu8", User: 45, System: 45, Idle: 60}})
	numberNear(t, rows[0].UsagePercent, 20)
	numberNear(t, rows[1].UsagePercent, 80)
	rows, _ = c.sampleLogicalCPUs(append(first, cpu.TimesStat{CPU: "cpu15", User: 10, Idle: 90}))
	for _, row := range rows {
		if row.UsagePercent != nil {
			t.Fatal("topology change must reset all baselines")
		}
	}
	rows, codes = c.sampleLogicalCPUs([]cpu.TimesStat{{CPU: "cpu2"}, {CPU: "cpu2"}, {CPU: "cpu-total"}})
	if len(rows) != 1 || !hasUnavailable(codes, "cpu-logical:duplicate-id") || !hasUnavailable(codes, "cpu-logical:unsupported-id") {
		t.Fatal("invalid logical identities not reported")
	}
	large := make([]cpu.TimesStat, maxLogicalCPUs+4)
	for index := range large {
		large[index] = cpu.TimesStat{CPU: fmt.Sprintf("cpu%d", index)}
	}
	rows, codes = c.sampleLogicalCPUs(large)
	if len(rows) != maxLogicalCPUs || len(c.logicalPrevious) != maxLogicalCPUs || !hasUnavailable(codes, "cpu-logical:truncated") {
		t.Fatal("logical CPU bound not enforced")
	}
	for _, name := range []string{"0", "cpu-total", "cpu-1", "cpu1.5", "cpu9999999999999999"} {
		if _, valid := logicalCPUID(name); valid {
			t.Fatalf("accepted invalid logical ID %s", name)
		}
	}
	duplicated := []string{}
	for index := 0; index < 100; index++ {
		duplicated = append(duplicated, fmt.Sprint(index), fmt.Sprint(index))
	}
	if codes = boundedUnavailable(duplicated); len(codes) != 64 || codes[0] != "0" || codes[63] != "63" {
		t.Fatal("unavailable reasons not deduplicated and bounded")
	}
}
func TestDiskRatesResetHotplugAndLimits(t *testing.T) {
	c := &collector{}
	now := time.Now()
	first := diskCounter{ID: "disk0", Name: "real-device", ReadBytes: 10000, WriteBytes: 50000, IOAvailable: true, BusyMillis: uint64Pointer(100), SampledAt: now}
	rows, _ := c.sampleDisks([]diskCounter{first})
	if rows[0].ReadBytesPerSecond != nil || rows[0].ActivePercent != nil {
		t.Fatal("first sample must be unavailable")
	}
	second := first
	second.ReadBytes += 1024
	second.WriteBytes += 2048
	second.BusyMillis = uint64Pointer(350)
	second.SampledAt = now.Add(time.Second)
	rows, _ = c.sampleDisks([]diskCounter{second})
	numberNear(t, rows[0].ReadBytesPerSecond, 1024)
	numberNear(t, rows[0].WriteBytesPerSecond, 2048)
	numberNear(t, rows[0].ActivePercent, 25)
	reset := second
	reset.ReadBytes = 1
	reset.SampledAt = now.Add(2 * time.Second)
	rows, _ = c.sampleDisks([]diskCounter{reset})
	if rows[0].ReadBytesPerSecond != nil || rows[0].WriteBytesPerSecond != nil || rows[0].ActivePercent != nil {
		t.Fatal("disk reset fabricated rates")
	}
	_, _ = c.sampleDisks(nil)
	rows, _ = c.sampleDisks([]diskCounter{second})
	if rows[0].ReadBytesPerSecond != nil {
		t.Fatal("reattached device reused stale counters")
	}
	large := make([]diskCounter, maxDisks+5)
	for index := range large {
		large[index] = diskCounter{ID: fmt.Sprintf("disk%d", index), Name: strings.Repeat("x", 300), SampledAt: now}
	}
	rows, codes := c.sampleDisks(large)
	if len(rows) != maxDisks || len(c.diskPrevious) != maxDisks || !hasUnavailable(codes, "disks:truncated") || len(rows[0].Name) > 256 {
		t.Fatal("disk bounds not enforced")
	}
	if counterRate(9, 10, time.Second) != nil || counterRate(10, 0, 0) != nil || counterRate(math.MaxUint64, 0, time.Nanosecond) != nil {
		t.Fatal("invalid throughput accepted")
	}
}
func TestDiskBusyTimeUsesActualCounter(t *testing.T) {
	previous := diskCounter{Idle100ns: uint64Pointer(10000000), Query100ns: uint64Pointer(100000000)}
	current := diskCounter{Idle100ns: uint64Pointer(17500000), Query100ns: uint64Pointer(110000000)}
	numberNear(t, diskActive(previous, current, time.Second), 25)
	current.Query100ns = uint64Pointer(150000000)
	if diskActive(previous, current, time.Second) != nil {
		t.Fatal("wall-clock jump fabricated activity")
	}
	current.Query100ns = uint64Pointer(110000000)
	current.Idle100ns = uint64Pointer(999)
	if diskActive(previous, current, time.Second) != nil {
		t.Fatal("counter reset fabricated activity")
	}
	if diskActive(diskCounter{}, diskCounter{}, time.Second) != nil {
		t.Fatal("unsupported activity must remain null")
	}
	c := &collector{}
	now := time.Now()
	before := diskCounter{ID: "darwin-device", IOAvailable: true, SampledAt: now}
	after := before
	after.ReadBytes = 10
	after.SampledAt = now.Add(time.Second)
	_, _ = c.sampleDisks([]diskCounter{before})
	rows, codes := c.sampleDisks([]diskCounter{after})
	numberNear(t, rows[0].ReadBytesPerSecond, 10)
	if rows[0].ActivePercent != nil || !hasUnavailable(codes, "disks:active-unavailable") {
		t.Fatal("read/write time must not masquerade as disk active time")
	}
}
