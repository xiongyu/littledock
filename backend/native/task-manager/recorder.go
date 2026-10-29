package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const recorderMaxRaw = 512 * 1024
const recorderIndexSize = 128
const recorderMaxSegments = 2048
const recorderMaxIndexBytes = 256 * 1024 * 1024

type recordingSettings struct {
	Enabled         bool `json:"enabled"`
	IntervalSeconds int  `json:"intervalSeconds"`
	RetentionDays   int  `json:"retentionDays"`
	MaxMiB          int  `json:"maxMiB"`
}
type recordingOperation struct {
	ID   string `json:"id"`
	Hash string `json:"hash"`
}
type recordingConfig struct {
	SchemaVersion int    `json:"schemaVersion"`
	Revision      uint64 `json:"revision"`
	recordingSettings
	Operations []recordingOperation `json:"operations"`
}
type recordingConfigureParams struct {
	OperationID      string `json:"operationId"`
	ExpectedRevision uint64 `json:"expectedRevision"`
	recordingSettings
}
type recordingRuntime struct {
	InstanceID      string `json:"instanceId"`
	PID             int    `json:"pid"`
	BootID          string `json:"bootId"`
	State           string `json:"state"`
	UpdatedAt       int64  `json:"updatedAt"`
	LastSampleAt    *int64 `json:"lastSampleAt,omitempty"`
	LastError       string `json:"lastError,omitempty"`
	RecorderVersion string `json:"recorderVersion,omitempty"`
	Failures        int    `json:"failures,omitempty"`
}
type recordingStatus struct {
	recordingSettings
	Revision        uint64 `json:"revision"`
	State           string `json:"state"`
	Running         bool   `json:"running"`
	Directory       string `json:"directory"`
	StoredBytes     int64  `json:"storedBytes"`
	LastSampleAt    *int64 `json:"lastSampleAt,omitempty"`
	LastError       string `json:"lastError,omitempty"`
	AvailableFrom   *int64 `json:"availableFrom,omitempty"`
	AvailableTo     *int64 `json:"availableTo,omitempty"`
	InstanceID      string `json:"instanceId,omitempty"`
	RecorderVersion string `json:"recorderVersion,omitempty"`
}
type historyDisk struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	ReadBytesPerSecond  *float64 `json:"readBytesPerSecond"`
	WriteBytesPerSecond *float64 `json:"writeBytesPerSecond"`
	ActivePercent       *float64 `json:"activePercent"`
}
type historyGPU struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	UtilizationPercent *float64 `json:"utilizationPercent"`
	Source             string   `json:"source"`
	UtilizationScope   string   `json:"utilizationScope,omitempty"`
}
type historySummary struct {
	ID           string       `json:"id"`
	Sequence     uint64       `json:"sequence"`
	SampledAt    int64        `json:"sampledAt"`
	BootID       string       `json:"bootId"`
	CPUPercent   *float64     `json:"cpuPercent"`
	CPUCount     int          `json:"cpuCount"`
	Memory       memoryDTO    `json:"memory"`
	ProcessCount int          `json:"processCount"`
	Disk         *historyDisk `json:"disk"`
	GPU          *historyGPU  `json:"gpu"`
}
type historyPoint struct {
	historySummary
	IntervalSeconds int             `json:"intervalSeconds"`
	Processes       []processDTO    `json:"processes"`
	Performance     *performanceDTO `json:"performance,omitempty"`
	Truncated       bool            `json:"truncated"`
}
type historyGap struct {
	From   int64  `json:"from"`
	To     int64  `json:"to"`
	Reason string `json:"reason"`
}
type historyPage struct {
	From          int64            `json:"from"`
	To            int64            `json:"to"`
	Points        []historySummary `json:"points"`
	TotalSamples  int              `json:"totalSamples"`
	Truncated     bool             `json:"truncated"`
	AvailableFrom *int64           `json:"availableFrom,omitempty"`
	AvailableTo   *int64           `json:"availableTo,omitempty"`
	Gaps          []historyGap     `json:"gaps"`
}

func recorderToken() string {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(value[:])
}
func recorderDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", fail("UNSAFE_PATH", "Recording directory is unavailable")
	}
	return filepath.Join(home, ".webnav", "tools", "task-manager", "recording-v1"), nil
}
func recorderCheckDirectory(path string, create bool) error {
	if !filepath.IsAbs(path) {
		return fail("UNSAFE_PATH", "Recording directory must be absolute")
	}
	chain := []string{}
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		chain = append(chain, current)
		if filepath.Dir(current) == current {
			break
		}
	}
	// Inspect each ancestor before creating its child: MkdirAll could otherwise
	// create directories outside this tree before a redirected path is noticed.
	for i := len(chain) - 1; i >= 0; i-- {
		info, err := os.Lstat(chain[i])
		if errors.Is(err, os.ErrNotExist) && create {
			if err = os.Mkdir(chain[i], 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return fail("RECORDING_STORAGE_FAILED", "Recording storage is unavailable")
			}
			info, err = os.Lstat(chain[i])
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail("UNSAFE_PATH", "Recording directory is redirected")
		}
	}
	resolved, err := filepath.EvalSymlinks(path)
	same := filepath.Clean(resolved) == filepath.Clean(path)
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(filepath.Clean(resolved), filepath.Clean(path))
	}
	if err != nil || !same {
		return fail("UNSAFE_PATH", "Recording directory is redirected")
	}
	if create {
		return recorderSecureDirectory(path)
	}
	return nil
}
func recorderReadJSON(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return fail("RECORDING_STORAGE_FAILED", "Invalid recording metadata")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return fail("RECORDING_STORAGE_FAILED", "Invalid recording metadata")
	}
	if err := decodeStrict(data, target); err != nil {
		return fail("RECORDING_STORAGE_FAILED", "Invalid recording metadata")
	}
	return nil
}
func recorderWriteJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > 64*1024 {
		return fail("RECORDING_STORAGE_FAILED", "Recording metadata limit exceeded")
	}
	token := recorderToken()
	if token == "" {
		return fail("RECORDING_STORAGE_FAILED", "Recording storage is unavailable")
	}
	temporary := path + ".tmp-" + token
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return recorderReplaceMetadata(temporary, path)
}
func recorderDefaultConfig() recordingConfig {
	return recordingConfig{SchemaVersion: 1, recordingSettings: recordingSettings{IntervalSeconds: 5, RetentionDays: 7, MaxMiB: 256}, Operations: []recordingOperation{}}
}
func recorderSettingsValid(value recordingSettings) bool {
	return (value.IntervalSeconds == 1 || value.IntervalSeconds == 2 || value.IntervalSeconds == 5 || value.IntervalSeconds == 10) && (value.RetentionDays == 1 || value.RetentionDays == 7 || value.RetentionDays == 30) && value.MaxMiB >= 64 && value.MaxMiB <= 1024
}
func recorderLoadConfig(directory string) (recordingConfig, error) {
	config := recorderDefaultConfig()
	err := recorderReadJSON(filepath.Join(directory, "config.json"), &config)
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil || config.SchemaVersion != 1 || !recorderSettingsValid(config.recordingSettings) || len(config.Operations) > 64 || config.Revision > uint64(maxSafeNumber) {
		return config, fail("RECORDING_STORAGE_FAILED", "Recording settings are invalid")
	}
	return config, nil
}
func recorderLockContext(ctx context.Context, path string) (func(), error) {
	for {
		unlock, err := recorderTryLock(path)
		if err == nil {
			return unlock, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fail("RECORDING_STORAGE_FAILED", "Recording lock is unavailable")
		}
		select {
		case <-ctx.Done():
			return nil, fail("RECORDING_BUSY", "Recording settings are busy")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
func recorderCheckLockPath(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fail("UNSAFE_PATH", "Recording lock is redirected")
	}
	return nil
}
func recorderIsRunning(directory string) (bool, error) {
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if errors.Is(err, os.ErrExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	unlock()
	return false, nil
}
func recorderGetStatus(directory string) (recordingStatus, error) {
	if err := recorderCheckDirectory(directory, false); err != nil && !errors.Is(err, os.ErrNotExist) {
		return recordingStatus{}, err
	}
	config, err := recorderLoadConfig(directory)
	if err != nil {
		return recordingStatus{}, err
	}
	status := recordingStatus{recordingSettings: config.recordingSettings, Revision: config.Revision, State: "disabled", Directory: directory}
	if errors.Is(recorderCheckDirectory(directory, false), os.ErrNotExist) {
		return status, nil
	}
	if err := recorderCheckDirectory(directory, false); err != nil {
		return status, err
	}
	status.Running, err = recorderIsRunning(directory)
	if err != nil {
		return status, fail("RECORDING_STORAGE_FAILED", "Recording status is unavailable")
	}
	var runtime recordingRuntime
	if err := recorderReadJSON(filepath.Join(directory, "status.json"), &runtime); err == nil {
		status.InstanceID = runtime.InstanceID
		status.LastSampleAt = runtime.LastSampleAt
		status.LastError = runtime.LastError
		status.RecorderVersion = runtime.RecorderVersion
	}
	if status.Running {
		status.State = "starting"
		if runtime.State == "recording" || runtime.State == "error" {
			status.State = runtime.State
		}
		if !config.Enabled {
			status.State = "stopping"
		}
	} else if config.Enabled {
		status.State = "stopped"
		if runtime.LastError != "" {
			status.State = "error"
		} else {
			status.LastError = "RECORDING_INTERRUPTED"
		}
	}
	if status.Running && time.Now().UnixMilli()-runtime.UpdatedAt > 30000 {
		status.State = "error"
		status.LastError = "RECORDING_INTERRUPTED"
	}
	segments, bytes, scanErr := recorderSegments(directory)
	if scanErr != nil {
		return status, scanErr
	}
	status.StoredBytes = bytes
	for _, segment := range segments {
		if segment.Corrupt && status.LastError == "" {
			status.LastError = "HISTORY_CORRUPT"
			break
		}
	}
	status.AvailableFrom, status.AvailableTo = recorderAvailability(segments, time.Now().UnixMilli()-int64(config.RetentionDays)*86400000)
	return status, nil
}
func recorderSpawn(executable string) error {
	return recorderSpawnMode(executable, "--record")
}
func recorderSpawnMode(executable, mode string) error {
	if mode != "--record" && mode != "--record-recover" {
		return fail("INVALID_REQUEST", "Invalid recording mode")
	}
	device, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer device.Close()
	command := exec.Command(executable, mode)
	command.Stdin = device
	command.Stdout = device
	command.Stderr = device
	command.Dir = filepath.Dir(executable)
	recorderDetach(command)
	if err := command.Start(); err != nil {
		return err
	}
	// Reap a child that fails early without attaching its lifetime to stdio.
	go func() { _ = command.Wait() }()
	return nil
}
func recorderConfigure(ctx context.Context, directory string, params recordingConfigureParams, spawn func() error) (recordingStatus, error) {
	if len(params.OperationID) < 1 || len(params.OperationID) > 128 || !recorderSettingsValid(params.recordingSettings) || params.ExpectedRevision > uint64(maxSafeNumber) {
		return recordingStatus{}, fail("INVALID_REQUEST", "Invalid recording settings")
	}
	if err := recorderCheckDirectory(directory, true); err != nil {
		return recordingStatus{}, err
	}
	lockCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	unlock, err := recorderLockContext(lockCtx, filepath.Join(directory, "config.lock"))
	if err != nil {
		return recordingStatus{}, err
	}
	defer unlock()
	config, err := recorderLoadConfig(directory)
	if err != nil {
		return recordingStatus{}, err
	}
	encoded, _ := json.Marshal(params)
	sum := sha256.Sum256(encoded)
	hash := hex.EncodeToString(sum[:])
	duplicate := false
	for _, operation := range config.Operations {
		if operation.ID == params.OperationID {
			if operation.Hash != hash {
				return recordingStatus{}, fail("OPERATION_CONFLICT", "Recording operation ID was reused")
			}
			duplicate = true
			break
		}
	}
	if !duplicate {
		if config.Revision != params.ExpectedRevision {
			return recordingStatus{}, fail("REVISION_CONFLICT", "Recording settings changed; reload before updating")
		}
		config.Revision++
		config.recordingSettings = params.recordingSettings
		config.Operations = append(config.Operations, recordingOperation{params.OperationID, hash})
		if len(config.Operations) > 64 {
			config.Operations = config.Operations[len(config.Operations)-64:]
		}
		if err := recorderWriteJSON(filepath.Join(directory, "config.json"), config); err != nil {
			return recordingStatus{}, fail("RECORDING_STORAGE_FAILED", "Recording settings could not be saved")
		}
	}
	if duplicate {
		return recorderGetStatus(directory)
	}
	running, err := recorderIsRunning(directory)
	if err != nil {
		return recordingStatus{}, fail("RECORDING_STORAGE_FAILED", "Recording status is unavailable")
	}
	if config.Enabled && !running {
		if err := spawn(); err != nil {
			return recordingStatus{}, fail("RECORDING_START_FAILED", "The host could not start an independent recorder")
		}
		deadline := time.Now().Add(1500 * time.Millisecond)
	launchWait:
		for time.Now().Before(deadline) {
			running, _ = recorderIsRunning(directory)
			if running {
				break
			}
			select {
			case <-ctx.Done():
				break launchWait
			case <-time.After(30 * time.Millisecond):
			}
		}
	}
	status, err := recorderGetStatus(directory)
	if err == nil && config.Enabled && !status.Running {
		status.State = "starting"
		status.LastError = ""
	}
	return status, err
}
func recorderTopProcesses(processes []processDTO) []processDTO {
	cpuSorted := append([]processDTO(nil), processes...)
	memorySorted := append([]processDTO(nil), processes...)
	sort.Slice(cpuSorted, func(i, j int) bool {
		a, b := cpuSorted[i].CPUPercent, cpuSorted[j].CPUPercent
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		return *a > *b
	})
	sort.Slice(memorySorted, func(i, j int) bool { return memorySorted[i].MemoryBytes > memorySorted[j].MemoryBytes })
	result := []processDTO{}
	seen := make(map[int32]bool)
	for _, list := range [][]processDTO{cpuSorted, memorySorted} {
		for index, item := range list {
			if index >= 20 {
				break
			}
			if seen[item.PID] {
				continue
			}
			seen[item.PID] = true
			item.Username = ""
			item.Executable = ""
			result = append(result, item)
		}
	}
	return result
}
func recorderPoint(snapshot snapshotDTO, interval int) historyPoint {
	point := historyPoint{historySummary: historySummary{Sequence: snapshot.Sequence, SampledAt: snapshot.SampledAt, BootID: snapshot.BootID, CPUPercent: snapshot.CPUPercent, CPUCount: snapshot.CPUCount, Memory: snapshot.Memory, ProcessCount: len(snapshot.Processes)}, IntervalSeconds: interval, Processes: recorderTopProcesses(snapshot.Processes), Performance: snapshot.Performance, Truncated: snapshot.Truncated}
	if snapshot.Performance != nil {
		maxDisk := -1.0
		maxActivity := -1.0
		for _, disk := range snapshot.Performance.Disks {
			score := -1.0
			if disk.ReadBytesPerSecond != nil {
				score = 0
				score += *disk.ReadBytesPerSecond
			}
			if disk.WriteBytesPerSecond != nil {
				if score < 0 {
					score = 0
				}
				score += *disk.WriteBytesPerSecond
			}
			activity := -1.0
			if disk.ActivePercent != nil {
				activity = *disk.ActivePercent
			}
			if activity > maxActivity || activity == maxActivity && score > maxDisk {
				maxDisk = score
				maxActivity = activity
				point.Disk = &historyDisk{disk.ID, disk.Name, disk.ReadBytesPerSecond, disk.WriteBytesPerSecond, disk.ActivePercent}
			}
		}
		maxGPU := -1.0
		for _, gpu := range snapshot.Performance.GPUs {
			if gpu.UtilizationPercent != nil && *gpu.UtilizationPercent > maxGPU {
				maxGPU = *gpu.UtilizationPercent
				point.GPU = &historyGPU{gpu.ID, gpu.Name, gpu.UtilizationPercent, gpu.Source, gpu.UtilizationScope}
			}
		}
	}
	return point
}

func recorderDispatch(ctx context.Context, req request) (any, error) {
	directory, err := recorderDirectory()
	if err != nil {
		return nil, err
	}
	switch req.Method {
	case "recording.status":
		if err := decodeParams(req.Params, &struct{}{}); err != nil {
			return nil, err
		}
		return recorderGetStatus(directory)
	case "recording.configure":
		var params recordingConfigureParams
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(req.Params, &fields)
		for _, name := range []string{"operationId", "expectedRevision", "enabled", "intervalSeconds", "retentionDays", "maxMiB"} {
			if value, ok := fields[name]; !ok || string(value) == "null" {
				return nil, fail("INVALID_REQUEST", "Recording settings require all fields")
			}
		}
		return recorderConfigure(ctx, directory, params, func() error {
			executable, err := os.Executable()
			if err != nil {
				return err
			}
			return recorderSpawn(executable)
		})
	case "history.query":
		var params historyQuery
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(req.Params, &fields)
		for _, name := range []string{"from", "to"} {
			if value, ok := fields[name]; !ok || string(value) == "null" {
				return nil, fail("INVALID_REQUEST", "Historical query requires a fixed range")
			}
		}
		if value, ok := fields["maxPoints"]; ok && (params.MaxPoints == 0 || string(value) == "null") {
			return nil, fail("INVALID_REQUEST", "Invalid historical point limit")
		}
		return recorderQuery(ctx, directory, params)
	case "history.point":
		var params struct {
			ID string `json:"id"`
		}
		if err := decodeParams(req.Params, &params); err != nil {
			return nil, err
		}
		return recorderReadPoint(directory, params.ID)
	}
	return nil, fail("UNKNOWN_METHOD", "Unknown recorder method")
}
