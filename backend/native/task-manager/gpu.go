package main

import (
	"context"
	"encoding/csv"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxGPUs = 16
const maxGPUBytes = 64 * 1024

type gpuDTO struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	UtilizationPercent     *float64 `json:"utilizationPercent"`
	MemoryUsedBytes        *uint64  `json:"memoryUsedBytes"`
	MemoryTotalBytes       *uint64  `json:"memoryTotalBytes"`
	SharedMemoryUsedBytes  *uint64  `json:"sharedMemoryUsedBytes,omitempty"`
	SharedMemoryTotalBytes *uint64  `json:"sharedMemoryTotalBytes,omitempty"`
	UtilizationScope       string   `json:"utilizationScope,omitempty"`
	TemperatureCelsius     *float64 `json:"temperatureCelsius,omitempty"`
	Source                 string   `json:"source"`
	SampledAt              *int64   `json:"sampledAt,omitempty"`
}
type gpuSample struct {
	devices     []gpuDTO
	unavailable []string
}
type gpuRequest struct {
	ctx      context.Context
	response chan gpuSample
}
type gpuSampler struct {
	once     sync.Once
	stopOnce sync.Once
	requests chan gpuRequest
	stop     chan struct{}
	mu       sync.Mutex
	last     gpuSample
	collect  func(context.Context) ([]gpuDTO, []string)
	cleanup  func()
}

var gpuMonitor = &gpuSampler{requests: make(chan gpuRequest), stop: make(chan struct{}), collect: collectGPUPlatform, cleanup: closeGPUPlatform}

// A single worker bounds even a driver/provider that stops responding. No new
// goroutines or native queries are created on successive sampling timeouts.
func (s *gpuSampler) run() {
	defer s.cleanup()
	for {
		select {
		case <-s.stop:
			return
		case request := <-s.requests:
			devices, unavailable := s.collect(request.ctx)
			if devices == nil {
				devices = []gpuDTO{}
			}
			if unavailable == nil {
				unavailable = []string{}
			}
			if len(devices) > maxGPUs {
				devices = devices[:maxGPUs]
				unavailable = append(unavailable, "gpu:truncated")
			}
			sample := gpuSample{devices, unavailable}
			s.mu.Lock()
			s.last = sample
			s.mu.Unlock()
			request.response <- sample
		}
	}
}
func (s *gpuSampler) stale(reason string) ([]gpuDTO, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices := append([]gpuDTO{}, s.last.devices...)
	// A stale reading is never relabelled with the current sampling time.
	for i := range devices {
		if devices[i].SampledAt == nil || time.Now().UnixMilli()-*devices[i].SampledAt > 10_000 {
			devices[i].UtilizationPercent = nil
			devices[i].MemoryUsedBytes = nil
			devices[i].SharedMemoryUsedBytes = nil
			devices[i].TemperatureCelsius = nil
		}
	}
	return devices, append(append([]string{}, s.last.unavailable...), reason)
}
func gatherGPU(ctx context.Context) ([]gpuDTO, []string) {
	return gpuMonitor.sample(ctx)
}
func (s *gpuSampler) sample(ctx context.Context) ([]gpuDTO, []string) {
	select {
	case <-s.stop:
		return []gpuDTO{}, []string{"gpu:stopped"}
	default:
	}
	s.once.Do(func() { go s.run() })
	deadline, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	request := gpuRequest{deadline, make(chan gpuSample, 1)}
	select {
	case s.requests <- request:
	case <-deadline.Done():
		return s.stale("gpu:timed-out")
	case <-s.stop:
		return []gpuDTO{}, []string{"gpu:stopped"}
	}
	select {
	case sample := <-request.response:
		return sample.devices, sample.unavailable
	case <-deadline.Done():
		return s.stale("gpu:timed-out")
	case <-s.stop:
		return []gpuDTO{}, []string{"gpu:stopped"}
	}
}
func closeGPU() {
	gpuMonitor.stopOnce.Do(func() { close(gpuMonitor.stop) })
	// OS queries may be stuck, but external driver tools remain owned and
	// must be synchronously terminated before main exits.
	closeGPUCommands()
}

func gpuNumber(text string, min, max float64) *float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < min || value > max {
		return nil
	}
	return &value
}
func gpuBytes(text string, unit uint64) *uint64 {
	value := gpuNumber(text, 0, float64((uint64(1)<<53)-1)/float64(unit))
	if value == nil {
		return nil
	}
	bytes := uint64(*value * float64(unit))
	return &bytes
}

// NVIDIA documents UUID as a stable identity and MiB as the memory CSV unit.
// Missing/unsupported driver fields remain null, including MIG utilization.
func parseNvidiaGPU(data []byte, sampledAt int64) ([]gpuDTO, []string) {
	if len(data) > maxGPUBytes {
		return []gpuDTO{}, []string{"gpu:nvidia-output-limit"}
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = 6
	devices := []gpuDTO{}
	unavailable := []string{}
	seen := make(map[string]bool)
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return devices, append(unavailable, "gpu:nvidia-invalid-output")
		}
		if len(devices) >= maxGPUs {
			unavailable = append(unavailable, "gpu:truncated")
			break
		}
		id := strings.TrimSpace(row[0])
		if !strings.HasPrefix(id, "GPU-") || len(id) <= 4 || len(id) > 128 || strings.IndexFunc(id, func(value rune) bool {
			return !(value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '-')
		}) >= 0 || seen[id] {
			unavailable = append(unavailable, "gpu:nvidia-invalid-identity")
			continue
		}
		seen[id] = true
		device := gpuDTO{ID: "nvidia:" + id, Name: boundedText(strings.TrimSpace(row[1]), 256), UtilizationPercent: gpuNumber(row[2], 0, 100), MemoryUsedBytes: gpuBytes(row[3], 1024*1024), MemoryTotalBytes: gpuBytes(row[4], 1024*1024), TemperatureCelsius: gpuNumber(row[5], -100, 250), Source: "nvidia-smi", SampledAt: &sampledAt}
		if device.Name == "" {
			device.Name = "NVIDIA GPU"
		}
		if device.MemoryTotalBytes != nil && *device.MemoryTotalBytes == 0 {
			device.MemoryTotalBytes = nil
		}
		if device.MemoryUsedBytes != nil && device.MemoryTotalBytes != nil && *device.MemoryUsedBytes > *device.MemoryTotalBytes {
			device.MemoryUsedBytes = nil
			unavailable = append(unavailable, "gpu:nvidia-memory-invalid")
		}
		if device.UtilizationPercent == nil || device.MemoryUsedBytes == nil || device.MemoryTotalBytes == nil {
			unavailable = append(unavailable, "gpu:nvidia-partial")
		}
		devices = append(devices, device)
	}
	return devices, unavailable
}

type gpuBuffer struct {
	data  []byte
	limit int
}

func (b *gpuBuffer) Write(data []byte) (int, error) {
	if len(b.data)+len(data) > b.limit {
		remaining := b.limit - len(b.data)
		if remaining > 0 {
			b.data = append(b.data, data[:remaining]...)
		}
		return remaining, errors.New("GPU output exceeded limit")
	}
	b.data = append(b.data, data...)
	return len(data), nil
}
