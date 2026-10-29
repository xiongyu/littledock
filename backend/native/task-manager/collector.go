package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/user"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

const maxProcesses = 10000
const maxDetails = 200

type processDTO struct {
	PID         int32    `json:"pid"`
	PPID        int32    `json:"ppid"`
	StartedAt   int64    `json:"startedAt"`
	Name        string   `json:"name"`
	CPUPercent  *float64 `json:"cpuPercent"`
	MemoryBytes uint64   `json:"memoryBytes"`
	Username    string   `json:"username,omitempty"`
	Status      string   `json:"status,omitempty"`
	Threads     int32    `json:"threads,omitempty"`
	Executable  string   `json:"executable,omitempty"`
}
type helloDTO struct {
	Version      string   `json:"version"`
	Protocol     int      `json:"protocol"`
	Platform     string   `json:"platform"`
	Arch         string   `json:"arch"`
	Hostname     string   `json:"hostname"`
	Username     string   `json:"username"`
	Home         string   `json:"home"`
	BootID       string   `json:"bootId"`
	Capabilities []string `json:"capabilities"`
}
type memoryDTO struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}
type snapshotDTO struct {
	Sequence      uint64          `json:"sequence"`
	SampledAt     int64           `json:"sampledAt"`
	BootID        string          `json:"bootId"`
	Hostname      string          `json:"hostname"`
	Platform      string          `json:"platform"`
	Arch          string          `json:"arch"`
	CPUPercent    *float64        `json:"cpuPercent"`
	CPUCount      int             `json:"cpuCount"`
	UptimeSeconds uint64          `json:"uptimeSeconds"`
	Memory        memoryDTO       `json:"memory"`
	Processes     []processDTO    `json:"processes"`
	Truncated     bool            `json:"truncated"`
	Capabilities  []string        `json:"capabilities"`
	Performance   *performanceDTO `json:"performance,omitempty"`
}
type processSample struct {
	startedAt int64
	cpuTime   float64
	cpuKnown  bool
	sampledAt time.Time
	metadata  processDTO
}
type processMetadata struct {
	name    string
	ppid    int32
	threads int32
}
type collector struct {
	hello           helloDTO
	sequence        uint64
	previous        map[int32]processSample
	systemPrevious  *cpu.TimesStat
	protected       map[int32]int64
	cpuCount        int
	heartbeat       func()
	logicalPrevious map[int]cpu.TimesStat
	logicalCount    int
	diskPrevious    map[string]diskCounter
}

func platformName() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
func archName() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}
func bounded(value string) string {
	return boundedText(value, 2048)
}
func boundedText(value string, limit int) string {
	value = strings.ReplaceAll(value, "\x00", "�")
	value = strings.ToValidUTF8(value, "�")
	if len(value) > limit {
		value = strings.ToValidUTF8(value[:limit], "")
	}
	return value
}
func newCollector() (*collector, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	current, err := user.Current()
	if err != nil {
		return nil, err
	}
	boot, err := host.BootTime()
	if err != nil {
		return nil, err
	}
	bootID := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s:%d", hostname, boot))))
	if runtime.GOOS == "linux" {
		if data, e := os.ReadFile("/proc/sys/kernel/random/boot_id"); e == nil {
			bootID = strings.TrimSpace(string(data))
		}
	}
	caps := []string{"processes", "cpu", "memory", "details", "command-line", "performance", "recording", "history"}
	if runtime.GOOS != "darwin" {
		caps = append(caps, "terminate-force")
	}
	if runtime.GOOS == "linux" {
		caps = append(caps, "terminate-graceful")
	}
	c := &collector{hello: helloDTO{version, 1, platformName(), archName(), boundedText(hostname, 256), boundedText(current.Username, 256), home, bootID, caps}, previous: make(map[int32]processSample), protected: make(map[int32]int64)}
	c.cpuCount, _ = cpu.Counts(true)
	if c.cpuCount < 1 {
		c.cpuCount = runtime.NumCPU()
	}
	// Protect the complete ancestry (including sshd / shell / the WebNav host).
	pid := int32(os.Getpid())
	for i := 0; pid > 0 && i < 256; i++ {
		p, e := process.NewProcess(pid)
		if e != nil {
			break
		}
		start, _ := p.CreateTime()
		c.protected[pid] = start
		parent, e := p.Ppid()
		if e != nil || parent == pid {
			break
		}
		pid = parent
	}
	return c, nil
}
func (c *collector) dispatch(ctx context.Context, req request) (any, error) {
	if req.Method == "recording.status" || req.Method == "recording.configure" || req.Method == "history.query" || req.Method == "history.point" {
		return recorderDispatch(ctx, req)
	}
	switch req.Method {
	case "hello", "ping", "stop", "snapshot":
		if err := decodeParams(req.Params, &struct{}{}); err != nil {
			return nil, err
		}
		if req.Method == "hello" {
			return c.hello, nil
		}
		if req.Method == "ping" {
			return struct {
				Time int64 `json:"time"`
			}{time.Now().UnixMilli()}, nil
		}
		if req.Method == "stop" {
			return struct {
				Stopped bool `json:"stopped"`
			}{true}, nil
		}
		return c.snapshot(ctx)
	case "details":
		var params identityParams
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		return c.details(ctx, params)
	case "commandLine":
		var params identityParams
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		return c.commandLine(ctx, params)
	case "terminate":
		var params terminateParams
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		return c.terminate(ctx, params)
	default:
		return nil, fail("UNKNOWN_METHOD", "Unknown collector method")
	}
}
func percent(value float64) *float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	value = math.Round(math.Max(0, math.Min(100, value))*100) / 100
	return &value
}
func (c *collector) readProcess(ctx context.Context, p *process.Process, now time.Time, metadata *processMetadata) (processDTO, processSample, error) {
	start, err := p.CreateTimeWithContext(ctx)
	if err != nil || start <= 0 {
		return processDTO{}, processSample{}, fail("PROCESS_UNAVAILABLE", "Process identity is unavailable")
	}
	var name string
	var ppid, threadCount int32
	if metadata != nil {
		name = metadata.name
		ppid = metadata.ppid
		threadCount = metadata.threads
	} else {
		name, _ = p.NameWithContext(ctx)
		ppid, _ = p.PpidWithContext(ctx)
		threadCount, _ = p.NumThreadsWithContext(ctx)
	}
	result := processDTO{PID: p.Pid, PPID: ppid, StartedAt: start, Name: boundedText(name, 1024)}
	if result.Name == "" {
		result.Name = fmt.Sprintf("PID %d", p.Pid)
	}
	if memory, e := p.MemoryInfoWithContext(ctx); e == nil {
		result.MemoryBytes = memory.RSS
	} else {
		return processDTO{}, processSample{}, fail("PROCESS_UNAVAILABLE", "Process memory cannot be read with current permissions")
	}
	if previous, ok := c.previous[p.Pid]; ok && previous.startedAt == start {
		result.Username = previous.metadata.Username
		result.Executable = previous.metadata.Executable
	} else {
		if username, e := p.UsernameWithContext(ctx); e == nil {
			result.Username = boundedText(username, 256)
		}
		if executable, e := p.ExeWithContext(ctx); e == nil {
			result.Executable = bounded(executable)
		}
	}
	if status, e := p.StatusWithContext(ctx); e == nil {
		result.Status = boundedText(strings.Join(status, ","), 100)
	}
	result.Threads = threadCount
	sample := processSample{startedAt: start, sampledAt: now}
	if times, e := p.TimesWithContext(ctx); e == nil {
		sample.cpuKnown = true
		sample.cpuTime = times.User + times.System
		if previous, ok := c.previous[p.Pid]; ok && previous.startedAt == start && previous.cpuKnown {
			elapsed := now.Sub(previous.sampledAt).Seconds()
			if elapsed > 0 {
				result.CPUPercent = percent((sample.cpuTime - previous.cpuTime) / elapsed / float64(c.cpuCount) * 100)
			}
		}
	}
	sample.metadata = result
	return result, sample, nil
}
func (c *collector) snapshot(ctx context.Context) (*snapshotDTO, error) {
	now := time.Now()
	c.sequence++
	s := &snapshotDTO{Sequence: c.sequence, SampledAt: now.UnixMilli(), BootID: c.hello.BootID, Hostname: c.hello.Hostname, Platform: c.hello.Platform, Arch: c.hello.Arch, CPUCount: c.cpuCount, Processes: make([]processDTO, 0), Capabilities: c.hello.Capabilities}
	s.UptimeSeconds, _ = host.UptimeWithContext(ctx)
	memory, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, err
	}
	s.Memory = memoryDTO{memory.Total, memory.Used}
	if times, e := cpu.TimesWithContext(ctx, false); e == nil && len(times) > 0 {
		current := times[0]
		if c.systemPrevious != nil {
			s.CPUPercent = cpuUsage(*c.systemPrevious, current, runtime.GOOS)
		}
		c.systemPrevious = &current
	}
	pids, metadata, err := platformProcesses(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(pids, func(i, j int) bool { return pids[i] < pids[j] })
	if len(pids) > maxProcesses {
		pids = pids[:maxProcesses]
		s.Truncated = true
	}
	previous := make(map[int32]processSample, len(pids))
	for _, pid := range pids {
		if ctx.Err() != nil {
			s.Truncated = true
			break
		}
		p, e := process.NewProcessWithContext(ctx, pid)
		if e != nil {
			s.Truncated = true
			continue
		}
		item, sample, e := c.readProcess(ctx, p, now, metadata[pid])
		if e != nil {
			s.Truncated = true
			continue
		}
		s.Processes = append(s.Processes, item)
		previous[pid] = sample
	}
	c.previous = previous
	s.Performance = c.gatherPerformance(ctx)
	boundSnapshot(s)
	return s, nil
}

// Leave headroom for envelope/id/newline, and trim by actual JSON bytes rather
// than assuming that a process-count cap also bounds long paths and user names.
func boundSnapshot(s *snapshotDTO) {
	const budget = maxResponseBytes - 1024
	data, _ := json.Marshal(s)
	if len(data) <= budget {
		return
	}
	s.Truncated = true
	all := s.Processes
	low, high := 0, len(all)
	for low < high {
		middle := (low + high + 1) / 2
		s.Processes = all[:middle]
		data, _ = json.Marshal(s)
		if len(data) <= budget {
			low = middle
		} else {
			high = middle - 1
		}
	}
	s.Processes = all[:low]
}
