package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const intelMaxClients = 1024
const intelMaxProcesses = 4096
const intelMaxFDs = 8192
const intelMaxFDBytes = 16384
const intelMaxScanBytes = 8 * 1024 * 1024
const intelMaxEngines = 32

var intelPCI = regexp.MustCompile(`(?i)^([0-9a-f]{4,8}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$`)
var intelNumericName = regexp.MustCompile(`^[0-9]{1,10}$`)
var intelEngineName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func normalizeGPUPCI(value string) string {
	match := intelPCI.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return ""
	}
	domain, err := strconv.ParseUint(match[1], 16, 16)
	if err != nil {
		return ""
	}
	device, _ := strconv.ParseUint(match[3], 16, 8)
	if device > 31 {
		return ""
	}
	return fmt.Sprintf("%04x:%s:%s.%s", domain, strings.ToLower(match[2]), strings.ToLower(match[3]), match[4])
}

type intelEngineSample struct {
	busy, total, capacity uint64
	cycles                bool
	sampledAt             time.Time
}
type intelClientSample struct {
	pci, driver, id string
	owners          map[string]bool
	engines         map[string]intelEngineSample
}
type intelScan struct {
	clients                                 map[string]intelClientSample
	denied, limited, malformed, unavailable bool
}
type intelPrevious struct {
	owners  map[string]bool
	engines map[string]intelEngineSample
}
type intelGPUHistory struct{ clients map[string]intelPrevious }

// Kernel fdinfo keys are standardized. i915 exposes nanoseconds; xe exposes
// busy/total cycles. Capacities describe identical engines grouped by class.
func parseIntelFDInfo(data []byte, owner string, sampledAt time.Time) (intelClientSample, error) {
	result := intelClientSample{owners: map[string]bool{owner: true}, engines: make(map[string]intelEngineSample)}
	if len(data) > intelMaxFDBytes {
		return result, errors.New("fdinfo too large")
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		if len(line) > 1024 {
			return result, errors.New("fdinfo field too large")
		}
		key, value, found := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		if !found || !strings.HasPrefix(key, "drm-") {
			continue
		}
		if _, duplicate := fields[key]; duplicate {
			return result, errors.New("duplicate fdinfo field")
		}
		fields[key] = strings.TrimSpace(value)
		if len(fields) > 256 {
			return result, errors.New("too many fdinfo fields")
		}
	}
	result.driver = fields["drm-driver"]
	result.pci = normalizeGPUPCI(fields["drm-pdev"])
	if result.driver != "i915" && result.driver != "xe" {
		return result, errors.New("not Intel fdinfo")
	}
	id, err := strconv.ParseUint(fields["drm-client-id"], 10, 64)
	if err != nil || result.pci == "" {
		return result, errors.New("missing client identity")
	}
	result.id = strconv.FormatUint(id, 10)
	for key, value := range fields {
		var engineName string
		var cycles bool
		if strings.HasPrefix(key, "drm-engine-") && !strings.HasPrefix(key, "drm-engine-capacity-") {
			engineName = strings.TrimPrefix(key, "drm-engine-")
		} else if strings.HasPrefix(key, "drm-cycles-") {
			engineName = strings.TrimPrefix(key, "drm-cycles-")
			cycles = true
		} else {
			continue
		}
		if !intelEngineName.MatchString(engineName) || len(result.engines) >= intelMaxEngines {
			return result, errors.New("invalid engine list")
		}
		parts := strings.Fields(value)
		if len(parts) == 0 || (!cycles && (len(parts) != 2 || parts[1] != "ns")) || (cycles && len(parts) != 1) {
			return result, errors.New("invalid engine units")
		}
		busy, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			return result, err
		}
		capacity := uint64(1)
		if raw, ok := fields["drm-engine-capacity-"+engineName]; ok {
			capacity, err = strconv.ParseUint(raw, 10, 16)
			if err != nil || capacity == 0 || capacity > 4096 {
				return result, errors.New("invalid engine capacity")
			}
		}
		engine := intelEngineSample{busy: busy, capacity: capacity, cycles: cycles, sampledAt: sampledAt}
		if cycles {
			engine.total, err = strconv.ParseUint(fields["drm-total-cycles-"+engineName], 10, 64)
			if err != nil {
				continue
			}
		}
		if previous, exists := result.engines[engineName]; exists && previous.cycles != cycles {
			return result, errors.New("ambiguous engine units")
		}
		result.engines[engineName] = engine
	}
	return result, nil
}

func intelClientKey(client intelClientSample) string {
	return client.pci + "/" + client.driver + "/" + client.id
}
func mergeIntelClient(clients map[string]intelClientSample, sample intelClientSample) bool {
	key := intelClientKey(sample)
	current, exists := clients[key]
	if !exists {
		if len(clients) >= intelMaxClients {
			return false
		}
		clients[key] = sample
		return true
	}
	for owner := range sample.owners {
		if len(current.owners) < 64 {
			current.owners[owner] = true
		}
	}
	for name, engine := range sample.engines {
		old, exists := current.engines[name]
		if !exists || engine.busy > old.busy || engine.cycles && engine.total > old.total {
			if len(current.engines) < intelMaxEngines || exists {
				current.engines[name] = engine
			}
		}
	}
	clients[key] = current
	return true
}
func sharedIntelOwner(a, b map[string]bool) bool {
	for owner := range a {
		if b[owner] {
			return true
		}
	}
	return false
}

func (history *intelGPUHistory) sample(scan intelScan, now time.Time) (map[string]*float64, []string) {
	values := make(map[string]*float64)
	engines := make(map[string]map[string]float64)
	next := make(map[string]intelPrevious, len(scan.clients))
	missing := []string{"gpu:intel-visible-clients"}
	if scan.denied {
		missing = append(missing, "gpu:intel-fdinfo-permission-denied")
	}
	if scan.limited {
		missing = append(missing, "gpu:intel-fdinfo-truncated")
	}
	if scan.malformed {
		missing = append(missing, "gpu:intel-fdinfo-invalid")
	}
	if scan.unavailable {
		missing = append(missing, "gpu:intel-fdinfo-unavailable")
	}
	for key, client := range scan.clients {
		if _, found := values[client.pci]; !found {
			values[client.pci] = nil
		}
		old, continuous := history.clients[key]
		continuous = continuous && sharedIntelOwner(old.owners, client.owners)
		current := intelPrevious{owners: client.owners, engines: make(map[string]intelEngineSample, len(client.engines))}
		if len(client.engines) == 0 {
			missing = append(missing, "gpu:intel-engine-counters-unavailable")
		}
		for name, value := range client.engines {
			previous, known := old.engines[name]
			current.engines[name] = value
			if !continuous || !known || previous.cycles != value.cycles || previous.capacity != value.capacity {
				missing = append(missing, "gpu:intel-warming-up")
				continue
			}
			if value.busy < previous.busy {
				// Kernel permits briefly non-monotonic accounting. Keep its high
				// water mark until it catches up; a prolonged reset starts afresh.
				if now.Sub(previous.sampledAt) < 5*time.Second {
					current.engines[name] = previous
				}
				missing = append(missing, "gpu:intel-counter-reset")
				continue
			}
			denominator := float64(value.sampledAt.Sub(previous.sampledAt).Nanoseconds())
			if value.cycles {
				if value.total <= previous.total {
					missing = append(missing, "gpu:intel-counter-reset")
					continue
				}
				denominator = float64(value.total - previous.total)
			}
			if denominator <= 0 {
				missing = append(missing, "gpu:intel-warming-up")
				continue
			}
			percent := float64(value.busy-previous.busy) / denominator / float64(value.capacity) * 100
			if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 {
				continue
			}
			if engines[client.pci] == nil {
				engines[client.pci] = make(map[string]float64)
			}
			engines[client.pci][name] += percent
		}
		next[key] = current
	}
	history.clients = next
	for pci, classes := range engines {
		// Sum each class across distinct visible DRM clients, normalize by
		// that class's capacity, then choose the busiest class. This is a
		// class average when several physical engines share a class.
		maximum := 0.0
		for _, value := range classes {
			maximum = math.Max(maximum, value)
		}
		maximum = math.Min(100, maximum)
		values[pci] = &maximum
	}
	return values, missing
}

func readIntelBounded(path string, limit int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(limit+1)))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return data, io.ErrShortBuffer
	}
	return data, nil
}
func intelProcessOwner(procRoot, pid string) (string, error) {
	data, err := readIntelBounded(filepath.Join(procRoot, pid, "stat"), 4096)
	if err != nil {
		return "", err
	}
	close := strings.LastIndex(string(data), ") ")
	if close < 0 {
		return "", errors.New("invalid process identity")
	}
	fields := strings.Fields(string(data[close+2:]))
	if len(fields) <= 19 {
		return "", errors.New("invalid process identity")
	}
	if _, err = strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", err
	}
	return pid + ":" + fields[19], nil
}

// Proc scope is deliberately bounded, with permission and truncation flags.
// Never report this sum as a whole-device/global utilization measurement.
func scanIntelFDInfo(ctx context.Context, procRoot string, devices map[string]bool) intelScan {
	result := intelScan{clients: make(map[string]intelClientSample)}
	root, err := os.Open(procRoot)
	if err != nil {
		result.unavailable = true
		result.denied = os.IsPermission(err)
		return result
	}
	defer root.Close()
	entries, err := root.ReadDir(intelMaxProcesses + 256)
	if err != nil && err != io.EOF {
		result.unavailable = true
	}
	if len(entries) == intelMaxProcesses+256 {
		result.limited = true
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	processes, files, bytesRead := 0, 0, 0
	for _, entry := range entries {
		pid := entry.Name()
		if !entry.IsDir() || !intelNumericName.MatchString(pid) {
			continue
		}
		processes++
		if processes > intelMaxProcesses || ctx.Err() != nil {
			result.limited = true
			break
		}
		owner, err := intelProcessOwner(procRoot, pid)
		if err != nil {
			if os.IsPermission(err) {
				result.denied = true
			}
			continue
		}
		directory, err := os.Open(filepath.Join(procRoot, pid, "fdinfo"))
		if err != nil {
			if os.IsPermission(err) {
				result.denied = true
			}
			continue
		}
		fds, readErr := directory.ReadDir(513)
		directory.Close()
		if readErr != nil && readErr != io.EOF {
			result.denied = result.denied || os.IsPermission(readErr)
			result.limited = true
		}
		if len(fds) > 512 {
			result.limited = true
			fds = fds[:512]
		}
		for _, fd := range fds {
			if !intelNumericName.MatchString(fd.Name()) {
				continue
			}
			files++
			if files > intelMaxFDs || bytesRead >= intelMaxScanBytes || ctx.Err() != nil {
				result.limited = true
				return result
			}
			data, err := readIntelBounded(filepath.Join(procRoot, pid, "fdinfo", fd.Name()), intelMaxFDBytes)
			bytesRead += len(data)
			if err != nil {
				if os.IsPermission(err) {
					result.denied = true
				} else if errors.Is(err, io.ErrShortBuffer) {
					result.limited = true
				}
				continue
			}
			if !strings.Contains(string(data), "drm-driver:") {
				continue
			}
			client, err := parseIntelFDInfo(data, owner, time.Now())
			if err != nil {
				if strings.Contains(string(data), "i915") || strings.Contains(string(data), "xe") {
					result.malformed = true
				}
				continue
			}
			if !devices[client.pci] {
				continue
			}
			// Re-read the process creation identity before trusting its counters.
			current, err := intelProcessOwner(procRoot, pid)
			if err != nil || current != owner {
				result.limited = true
				continue
			}
			if !mergeIntelClient(result.clients, client) {
				result.limited = true
				return result
			}
		}
	}
	return result
}

type intelMemoryInfo struct{ localTotal, localUsed, sharedUsed *uint64 }

// i915 hides usage without CAP_PERFMON/CAP_SYS_ADMIN. Xe's memory-region
// query exposes TTM usage to callers allowed to open the render node.
func parseIntelMemoryRegions(driver string, data []byte, canReadUsed bool) (intelMemoryInfo, error) {
	result := intelMemoryInfo{}
	header, stride := 16, 88
	if driver == "xe" {
		header, stride = 8, 88
		canReadUsed = true
	} else if driver != "i915" {
		return result, errors.New("unsupported Intel driver")
	}
	if len(data) < header {
		return result, errors.New("short memory query")
	}
	count := int(binary.LittleEndian.Uint32(data[:4]))
	if count < 1 || count > 32 || len(data) < header+count*stride {
		return result, errors.New("invalid memory regions")
	}
	localTotal, localUsed, sharedUsed := uint64(0), uint64(0), uint64(0)
	hasLocal, hasShared := false, false
	localUsageKnown := canReadUsed
	seen := make(map[uint32]bool)
	for index := 0; index < count; index++ {
		region := data[header+index*stride : header+(index+1)*stride]
		class := binary.LittleEndian.Uint16(region[:2])
		identity := binary.LittleEndian.Uint32(region[:4])
		if seen[identity] {
			return result, errors.New("duplicate memory region")
		}
		seen[identity] = true
		total := binary.LittleEndian.Uint64(region[8:16])
		used := binary.LittleEndian.Uint64(region[16:24])
		if total == 0 || total >= uint64(1)<<53 || used > total {
			return result, errors.New("invalid memory accounting")
		}
		if driver == "i915" {
			used = total - used
			// Old i915 kernels expose a total but fill unallocated=total even
			// for privileged callers. The newer CPU-visible field is a useful
			// ABI support marker; an otherwise ambiguous zero stays unknown.
			if class == 1 && used == 0 && binary.LittleEndian.Uint64(region[24:32]) == 0 {
				localUsageKnown = false
			}
		}
		if class == 1 {
			hasLocal = true
			if localTotal+total >= uint64(1)<<53 {
				return result, errors.New("memory overflow")
			}
			localTotal += total
			localUsed += used
		} else if class == 0 && driver == "xe" {
			hasShared = true
			if sharedUsed+used >= uint64(1)<<53 {
				return result, errors.New("memory overflow")
			}
			sharedUsed += used
		}
	}
	if hasLocal {
		result.localTotal = &localTotal
		if localUsageKnown {
			result.localUsed = &localUsed
		}
	}
	if hasShared && canReadUsed {
		result.sharedUsed = &sharedUsed
	}
	return result, nil
}
