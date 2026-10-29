package main

import (
	"context"
	"math"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

const maxLogicalCPUs = 4096
const maxDisks = 64
const maxSafeNumber = 9007199254740991

type logicalCPUDTO struct {
	ID           int      `json:"id"`
	UsagePercent *float64 `json:"usagePercent"`
}
type diskDTO struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	ReadBytesPerSecond  *float64 `json:"readBytesPerSecond"`
	WriteBytesPerSecond *float64 `json:"writeBytesPerSecond"`
	ActivePercent       *float64 `json:"activePercent"`
	TotalBytes          *uint64  `json:"totalBytes,omitempty"`
	UsedBytes           *uint64  `json:"usedBytes,omitempty"`
	Mount               string   `json:"mount,omitempty"`
	SampledAt           int64    `json:"sampledAt,omitempty"`
}
type performanceDTO struct {
	SampledAt   int64           `json:"sampledAt"`
	CPULogical  []logicalCPUDTO `json:"cpuLogical"`
	Disks       []diskDTO       `json:"disks"`
	GPUs        []gpuDTO        `json:"gpus"`
	Unavailable []string        `json:"unavailable"`
}

// Counters are absolute OS counters; the time carries Go's monotonic component.
// BusyMillis is only populated by kernels exposing actual non-idle I/O time.
// Windows exposes Idle100ns and its query timestamp instead. Read/write service
// durations are intentionally not substituted for active time (they overlap).
type diskCounter struct {
	ID          string
	Name        string
	ReadBytes   uint64
	WriteBytes  uint64
	IOAvailable bool
	BusyMillis  *uint64
	Idle100ns   *uint64
	Query100ns  *uint64
	TotalBytes  *uint64
	SampledAt   time.Time
}

func finiteNonnegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

// Linux guest time is already included in user/nice; Windows interrupt time is
// already included in kernel (System). Counting either twice inflates usage.
func cpuComponents(sample cpu.TimesStat, platform string) []float64 {
	if platform == "windows" {
		return []float64{sample.User, sample.System, sample.Idle, 0}
	}
	return []float64{sample.User, sample.System, sample.Idle, sample.Iowait, sample.Nice, sample.Irq, sample.Softirq, sample.Steal}
}
func cpuUsage(previous, current cpu.TimesStat, platform string) *float64 {
	before, after := cpuComponents(previous, platform), cpuComponents(current, platform)
	total, idle := 0.0, 0.0
	for index, value := range after {
		if !finiteNonnegative(value) || !finiteNonnegative(before[index]) || value < before[index] {
			return nil
		}
		delta := value - before[index]
		total += delta
		if index == 2 || index == 3 {
			idle += delta
		}
	}
	if !finiteNonnegative(total) || total <= 0 {
		return nil
	}
	return percent((total - idle) / total * 100)
}
func logicalCPUID(name string) (int, bool) {
	number, ok := strings.CutPrefix(name, "cpu")
	if !ok || number == "" {
		return 0, false
	}
	for _, character := range number {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	id, err := strconv.ParseUint(number, 10, 16)
	return int(id), err == nil
}
func (c *collector) sampleLogicalCPUs(times []cpu.TimesStat) ([]logicalCPUDTO, []string) {
	result := make([]logicalCPUDTO, 0, min(len(times), maxLogicalCPUs))
	unavailable := []string{}
	current := make(map[int]cpu.TimesStat, min(len(times), maxLogicalCPUs))
	// A changed topology can renumber flattened Windows processor-group IDs.
	previous := c.logicalPrevious
	if c.logicalCount != len(times) {
		previous = nil
	}
	ordered := append([]cpu.TimesStat(nil), times...)
	sort.Slice(ordered, func(i, j int) bool {
		a, _ := logicalCPUID(ordered[i].CPU)
		b, _ := logicalCPUID(ordered[j].CPU)
		return a < b
	})
	for _, sample := range ordered {
		id, ok := logicalCPUID(sample.CPU)
		if !ok {
			unavailable = append(unavailable, "cpu-logical:unsupported-id")
			continue
		}
		if _, duplicate := current[id]; duplicate {
			unavailable = append(unavailable, "cpu-logical:duplicate-id")
			continue
		}
		if len(result) >= maxLogicalCPUs {
			unavailable = append(unavailable, "cpu-logical:truncated")
			break
		}
		row := logicalCPUDTO{ID: id}
		if last, exists := previous[id]; exists {
			row.UsagePercent = cpuUsage(last, sample, runtime.GOOS)
		}
		current[id] = sample
		result = append(result, row)
	}
	if len(result) < c.cpuCount {
		unavailable = append(unavailable, "cpu-logical:truncated")
	}
	c.logicalPrevious = current
	c.logicalCount = len(times)
	return result, unavailable
}
func counterRate(current, previous uint64, elapsed time.Duration) *float64 {
	if current < previous || elapsed <= 0 {
		return nil
	}
	value := float64(current-previous) / elapsed.Seconds()
	if !finiteNonnegative(value) || value > maxSafeNumber {
		return nil
	}
	return &value
}
func diskActive(previous, current diskCounter, elapsed time.Duration) *float64 {
	if elapsed <= 0 {
		return nil
	}
	if current.BusyMillis != nil && previous.BusyMillis != nil {
		if *current.BusyMillis < *previous.BusyMillis {
			return nil
		}
		return percent(float64(*current.BusyMillis-*previous.BusyMillis) / (elapsed.Seconds() * 1000) * 100)
	}
	if current.Idle100ns != nil && previous.Idle100ns != nil && current.Query100ns != nil && previous.Query100ns != nil {
		if *current.Idle100ns < *previous.Idle100ns || *current.Query100ns <= *previous.Query100ns {
			return nil
		}
		query := *current.Query100ns - *previous.Query100ns
		idle := *current.Idle100ns - *previous.Idle100ns
		// QueryTime is a wall-clock timestamp. Reject a clock jump instead of
		// turning it into a fabricated disk activity spike.
		seconds := float64(query) / 10000000
		if math.Abs(seconds-elapsed.Seconds()) > math.Max(0.05, elapsed.Seconds()*0.1) || idle > query {
			return nil
		}
		return percent(float64(query-idle) / float64(query) * 100)
	}
	return nil
}
func (c *collector) sampleDisks(counters []diskCounter) ([]diskDTO, []string) {
	result := make([]diskDTO, 0, min(len(counters), maxDisks))
	unavailable := []string{}
	current := make(map[string]diskCounter, min(len(counters), maxDisks))
	for _, sample := range counters {
		if sample.ID == "" {
			continue
		}
		sample.ID = boundedText(sample.ID, 128)
		if _, exists := current[sample.ID]; exists {
			continue
		}
		if len(result) >= maxDisks {
			unavailable = append(unavailable, "disks:truncated")
			break
		}
		row := diskDTO{ID: sample.ID, Name: boundedText(sample.Name, 256), SampledAt: sample.SampledAt.UnixMilli(), TotalBytes: sample.TotalBytes}
		if row.Name == "" {
			row.Name = row.ID
		}
		if previous, exists := c.diskPrevious[sample.ID]; exists && previous.IOAvailable && sample.IOAvailable && sample.ReadBytes >= previous.ReadBytes && sample.WriteBytes >= previous.WriteBytes {
			elapsed := sample.SampledAt.Sub(previous.SampledAt)
			row.ReadBytesPerSecond = counterRate(sample.ReadBytes, previous.ReadBytes, elapsed)
			row.WriteBytesPerSecond = counterRate(sample.WriteBytes, previous.WriteBytes, elapsed)
			row.ActivePercent = diskActive(previous, sample, elapsed)
		}
		if !sample.IOAvailable {
			unavailable = append(unavailable, "disks:io-unavailable")
		}
		if sample.BusyMillis == nil && sample.Idle100ns == nil {
			unavailable = append(unavailable, "disks:active-unavailable")
		}
		current[sample.ID] = sample
		result = append(result, row)
	}
	c.diskPrevious = current
	return result, unavailable
}
func boundedUnavailable(codes []string) []string {
	result := make([]string, 0, min(len(codes), 64))
	seen := make(map[string]bool)
	for _, code := range codes {
		code = boundedText(code, 200)
		if code == "" || seen[code] {
			continue
		}
		if len(result) == 64 {
			break
		}
		seen[code] = true
		result = append(result, code)
	}
	return result
}
func (c *collector) gatherPerformance(ctx context.Context) *performanceDTO {
	result := &performanceDTO{SampledAt: time.Now().UnixMilli(), CPULogical: []logicalCPUDTO{}, Disks: []diskDTO{}, GPUs: []gpuDTO{}, Unavailable: []string{}}
	if times, err := cpu.TimesWithContext(ctx, true); err == nil && len(times) > 0 {
		var unavailable []string
		result.CPULogical, unavailable = c.sampleLogicalCPUs(times)
		result.Unavailable = append(result.Unavailable, unavailable...)
	} else {
		c.logicalPrevious = nil
		c.logicalCount = 0
		result.Unavailable = append(result.Unavailable, "cpu-logical")
	}
	counters, unavailable := gatherDiskCounters(ctx)
	result.Unavailable = append(result.Unavailable, unavailable...)
	result.Disks, unavailable = c.sampleDisks(counters)
	result.Unavailable = append(result.Unavailable, unavailable...)
	result.GPUs, unavailable = gatherGPU(ctx)
	result.Unavailable = append(result.Unavailable, unavailable...)
	if result.GPUs == nil {
		result.GPUs = []gpuDTO{}
	}
	if len(result.GPUs) > maxGPUs {
		result.GPUs = result.GPUs[:maxGPUs]
		result.Unavailable = append(result.Unavailable, "gpu:truncated")
	}
	result.Unavailable = boundedUnavailable(result.Unavailable)
	return result
}
