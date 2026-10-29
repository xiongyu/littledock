package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func recorderTestDirectory(t *testing.T) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "recording-v1")
	if err := recorderCheckDirectory(directory, true); err != nil {
		t.Fatal(err)
	}
	return directory
}
func recorderTestPoint(at int64, sequence uint64, cpuValue float64) historyPoint {
	return historyPoint{historySummary: historySummary{Sequence: sequence, SampledAt: at, BootID: "test-boot", CPUPercent: &cpuValue, CPUCount: 4, Memory: memoryDTO{Total: 1000, Used: 100}, ProcessCount: 1}, IntervalSeconds: 5, Processes: []processDTO{{PID: 50, PPID: 1, StartedAt: at - 100, Name: "sample", MemoryBytes: 123}}}
}
func recorderTestConfig(t *testing.T, directory string, enabled bool) recordingConfig {
	t.Helper()
	config, err := recorderLoadConfig(directory)
	if err != nil {
		t.Fatal(err)
	}
	config.Enabled = enabled
	config.IntervalSeconds = 1
	config.Revision++
	if err := recorderWriteJSON(filepath.Join(directory, "config.json"), config); err != nil {
		t.Fatal(err)
	}
	return config
}
func recorderErrorIs(err error, code string) bool {
	var public *publicError
	return errors.As(err, &public) && public.Code == code
}

func TestRecorderConfigurationConflictDedupAndOSLock(t *testing.T) {
	directory := recorderTestDirectory(t)
	status, err := recorderGetStatus(directory)
	if err != nil || status.Enabled || status.Revision != 0 || status.Running || status.IntervalSeconds != 5 || status.RetentionDays != 7 || status.MaxMiB != 256 {
		t.Fatalf("bad default %+v %v", status, err)
	}
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := recorderTryLock(filepath.Join(directory, "instance.lock")); !errors.Is(err, os.ErrExist) {
		t.Fatal("lock does not exclude another file handle", err)
	}
	params := recordingConfigureParams{OperationID: "same", recordingSettings: recordingSettings{Enabled: true, IntervalSeconds: 5, RetentionDays: 7, MaxMiB: 256}}
	spawned := 0
	spawn := func() error { spawned++; return nil }
	status, err = recorderConfigure(context.Background(), directory, params, spawn)
	if err != nil || status.Revision != 1 || spawned != 0 {
		t.Fatal(status, err)
	}
	status, err = recorderConfigure(context.Background(), directory, params, spawn)
	if err != nil || status.Revision != 1 {
		t.Fatal("duplicate changed revision", err)
	}
	params.Enabled = false
	if _, err := recorderConfigure(context.Background(), directory, params, spawn); !recorderErrorIs(err, "OPERATION_CONFLICT") {
		t.Fatal("operation ID payload change accepted", err)
	}
	params.OperationID = "new"
	if _, err := recorderConfigure(context.Background(), directory, params, spawn); !recorderErrorIs(err, "REVISION_CONFLICT") {
		t.Fatal("stale revision accepted", err)
	}
	var group sync.WaitGroup
	var successes int
	var mu sync.Mutex
	for _, id := range []string{"a", "b"} {
		group.Add(1)
		go func(id string) {
			defer group.Done()
			_, err := recorderConfigure(context.Background(), directory, recordingConfigureParams{OperationID: id, ExpectedRevision: 1, recordingSettings: params.recordingSettings}, spawn)
			if err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			} else if !recorderErrorIs(err, "REVISION_CONFLICT") {
				t.Errorf("concurrent configure: %v", err)
			}
		}(id)
	}
	group.Wait()
	if successes != 1 {
		t.Fatal("concurrent writers both committed", successes)
	}
}

func TestRecorderStorageRoundTripPeaksAndFixedRange(t *testing.T) {
	directory := recorderTestDirectory(t)
	config := recorderDefaultConfig()
	if err := recorderWriteJSON(filepath.Join(directory, "config.json"), config); err != nil {
		t.Fatal(err)
	}
	writer := recorderWriter{directory: directory}
	defer writer.close()
	at := time.Now().Add(-time.Hour).UnixMilli()
	ids := make(map[int]string)
	for i := 0; i < 100; i++ {
		value := float64(1)
		if i == 10 {
			value = 99
		}
		point := recorderTestPoint(at+int64(i)*5000, uint64(i+1), value)
		if i == 20 {
			point.Memory.Used = 999
		}
		if i == 30 {
			rate := 123456.0
			point.Disk = &historyDisk{ID: "disk", Name: "disk", ReadBytesPerSecond: &rate}
		}
		if i == 40 {
			busy := 98.0
			point.GPU = &historyGPU{ID: "gpu", Name: "gpu", UtilizationPercent: &busy, Source: "fixture"}
		}
		if err := writer.append(&point, point.SampledAt, 0, 0, config.recordingSettings); err != nil {
			t.Fatal(err)
		}
		ids[i] = point.ID
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: at, To: at + 99*5000, MaxPoints: 5})
	if err != nil || page.TotalSamples != 100 || len(page.Points) != 5 || !page.Truncated || len(page.Gaps) != 0 {
		t.Fatalf("bad downsample %+v %v", page, err)
	}
	seen := make(map[string]bool)
	for _, point := range page.Points {
		seen[point.ID] = true
	}
	for _, index := range []int{10, 20, 30, 40, 99} {
		if !seen[ids[index]] {
			t.Fatal("lost original peak/last", index)
		}
	}
	point, err := recorderReadPoint(directory, ids[10])
	if err != nil || point.Processes[0].Name != "sample" || *point.CPUPercent != 99 {
		t.Fatal(point, err)
	}
	_, err = recorderReadPoint(directory, "../../config:0")
	if !recorderErrorIs(err, "INVALID_REQUEST") {
		t.Fatal("unsafe ID accepted", err)
	}
	_, err = recorderQuery(context.Background(), directory, historyQuery{From: 0, To: 32 * 86400000})
	if !recorderErrorIs(err, "INVALID_REQUEST") {
		t.Fatal("unbounded query accepted", err)
	}
	before := page.To
	newPoint := recorderTestPoint(at+100*5000, 101, 100)
	if err := writer.append(&newPoint, newPoint.SampledAt, 0, 0, config.recordingSettings); err != nil {
		t.Fatal(err)
	}
	frozen, err := recorderQuery(context.Background(), directory, historyQuery{From: at, To: before, MaxPoints: 5})
	if err != nil || frozen.TotalSamples != 100 {
		t.Fatal("fixed range changed", err)
	}
}

func TestRecorderTopProcessesPrivacyAndUnknownMetrics(t *testing.T) {
	processes := make([]processDTO, 100)
	for i := range processes {
		cpuValue := float64(i)
		processes[i] = processDTO{PID: int32(i + 1), StartedAt: 123, Name: fmt.Sprint(i), CPUPercent: &cpuValue, MemoryBytes: uint64(100 - i), Username: "private-user", Executable: "private-path"}
	}
	point := recorderPoint(snapshotDTO{Sequence: 1, SampledAt: time.Now().UnixMilli(), BootID: "boot", CPUCount: 4, Memory: memoryDTO{Total: 1000, Used: 100}, Processes: processes}, 5)
	if len(point.Processes) != 40 || point.ProcessCount != 100 || point.CPUPercent != nil || point.Disk != nil || point.GPU != nil {
		t.Fatal("top/unknown fields wrong", point)
	}
	for _, process := range point.Processes {
		if process.Username != "" || process.Executable != "" {
			t.Fatal("private metadata stored")
		}
	}
	data, _ := json.Marshal(point)
	if !strings.Contains(string(data), `"cpuPercent":null`) || !strings.Contains(string(data), `"disk":null`) || !strings.Contains(string(data), `"gpu":null`) {
		t.Fatal("unknown values were omitted/fabricated")
	}
}

func TestRecorderRejectsRedirectedAncestorsBeforeCreating(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "redirect")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("host does not permit test symlinks")
	}
	if err := recorderCheckDirectory(filepath.Join(link, "new", "recording-v1"), true); !recorderErrorIs(err, "UNSAFE_PATH") {
		t.Fatal("redirected ancestor accepted", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created directories through redirected ancestor")
	}
}

func TestRecorderOldOperationDoesNotRestartExitedDaemon(t *testing.T) {
	directory := recorderTestDirectory(t)
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if err != nil {
		t.Fatal(err)
	}
	params := recordingConfigureParams{OperationID: "once", recordingSettings: recordingSettings{Enabled: true, IntervalSeconds: 5, RetentionDays: 7, MaxMiB: 256}}
	spawned := 0
	spawn := func() error { spawned++; return nil }
	if _, err := recorderConfigure(context.Background(), directory, params, spawn); err != nil {
		t.Fatal(err)
	}
	unlock()
	status, err := recorderConfigure(context.Background(), directory, params, spawn)
	if err != nil || spawned != 0 || status.Running || status.State != "stopped" {
		t.Fatal("operation replay restarted exited recorder", status, spawned, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	params.OperationID = "new"
	params.ExpectedRevision = 1
	started := time.Now()
	_, _ = recorderConfigure(ctx, directory, params, spawn)
	if time.Since(started) > time.Second {
		t.Fatal("cancellation spun in launch wait")
	}
}

func TestRecorderCapacityPrunesOldestAndSmallQueriesKeepEveryPoint(t *testing.T) {
	directory := recorderTestDirectory(t)
	settings := recorderDefaultConfig().recordingSettings
	settings.MaxMiB = 64
	writer := recorderWriter{directory: directory}
	defer writer.close()
	start := time.Now().Add(-time.Minute).UnixMilli()
	oldIDs := []string{}
	for i := 0; i < 18; i++ {
		point := recorderTestPoint(start+int64(i)*1000, uint64(i+1), float64(i))
		if err := writer.append(&point, point.SampledAt, 0, 0, settings); err != nil {
			t.Fatal(err)
		}
		oldIDs = append(oldIDs, point.ID)
		if err := writer.data.Truncate(recorderSegmentBytes); err != nil {
			t.Fatal(err)
		}
		writer.bytes = recorderSegmentBytes
		writer.close()
	}
	if err := writer.prune(settings, time.Now().UnixMilli(), 0); err != nil {
		t.Fatal(err)
	}
	segments, stored, err := recorderSegments(directory)
	if err != nil || stored > 64*1024*1024 || len(segments) >= 18 || len(segments) < 10 {
		t.Fatal("capacity pruning removed too much or exceeded cap", len(segments), stored, err)
	}
	if _, err := recorderReadPoint(directory, oldIDs[0]); !recorderErrorIs(err, "HISTORY_NOT_FOUND") {
		t.Fatal("oldest sample not pruned", err)
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: start, To: start + 18000, MaxPoints: 300})
	if err != nil || page.TotalSamples != len(page.Points) || page.Truncated {
		t.Fatal("small history query discarded original points", len(page.Points), page.TotalSamples, err)
	}
	if _, err := recorderReadPoint(directory, oldIDs[len(oldIDs)-1]); err != nil {
		t.Fatal("latest sample removed", err)
	}
}

func TestRecorderCorruptSegmentDoesNotBlockStatusStopOrNewSamples(t *testing.T) {
	directory := recorderTestDirectory(t)
	settings := recorderDefaultConfig().recordingSettings
	writer := recorderWriter{directory: directory}
	defer writer.close()
	now := time.Now().UnixMilli()
	bad := recorderTestPoint(now-2000, 1, 20)
	if err := writer.append(&bad, bad.SampledAt, 0, 0, settings); err != nil {
		t.Fatal(err)
	}
	badPath := filepath.Join(directory, writer.base+".index")
	writer.close()
	if err := os.WriteFile(badPath, make([]byte, recorderIndexSize), 0600); err != nil {
		t.Fatal(err)
	}
	good := recorderTestPoint(now, 2, 30)
	if err := writer.append(&good, now, 0, 0, settings); err != nil {
		t.Fatal("bad historical segment blocked new samples", err)
	}
	status, err := recorderGetStatus(directory)
	if err != nil || status.LastError != "HISTORY_CORRUPT" || status.AvailableFrom == nil || *status.AvailableFrom != now {
		t.Fatal("corruption hid healthy status", status, err)
	}
	_, err = recorderConfigure(context.Background(), directory, recordingConfigureParams{OperationID: "stop", recordingSettings: settings}, func() error { return errors.New("must not spawn") })
	if err != nil {
		t.Fatal("corruption blocked disable", err)
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: now - 5000, To: now, MaxPoints: 300})
	if err != nil || len(page.Points) != 1 || page.Points[0].ID != good.ID || !page.Truncated || len(page.Gaps) == 0 {
		t.Fatal("corruption hid healthy history", page, err)
	}
}

func TestRecorderClockRollbackAndBusiestActiveDisk(t *testing.T) {
	directory := recorderTestDirectory(t)
	writer := recorderWriter{directory: directory}
	defer writer.close()
	settings := recorderDefaultConfig().recordingSettings
	at := time.Now().Add(-time.Minute).UnixMilli()
	for i, offset := range []int64{0, 30000, 20000} {
		point := recorderTestPoint(at+offset, uint64(i+1), float64(i))
		if err := writer.append(&point, point.SampledAt, 0, 0, settings); err != nil {
			t.Fatal(err)
		}
	}
	segments, _, err := recorderSegments(directory)
	if err != nil || len(segments) != 2 {
		t.Fatal("clock rollback did not rotate", len(segments), err)
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: at, To: at + 30000, MaxPoints: 300})
	if err != nil || len(page.Points) != 3 {
		t.Fatal(page, err)
	}
	found := false
	for _, gap := range page.Gaps {
		if gap.Reason == "clock-change" && gap.From == at+20000 && gap.To == at+30000 {
			found = true
		}
	}
	if !found {
		t.Fatal("clock rollback lost explicit gap", page.Gaps)
	}
	busy, idle, slow, fast := 100.0, 10.0, 1.0, 100000000.0
	point := recorderPoint(snapshotDTO{Performance: &performanceDTO{Disks: []diskDTO{{ID: "stalled", Name: "stalled", ActivePercent: &busy, ReadBytesPerSecond: &slow}, {ID: "fast", Name: "fast", ActivePercent: &idle, ReadBytesPerSecond: &fast}}}}, 5)
	if point.Disk == nil || point.Disk.ID != "stalled" {
		t.Fatal("active stalled disk hidden by throughput")
	}
	if !recorderDiskHigher(recorderIndex{DiskActive: 100, DiskScore: 1}, recorderIndex{DiskActive: 10, DiskScore: 1000000}) {
		t.Fatal("history failed to preserve active disk peak")
	}
}

func TestRecorderRecoveryWaitHonorsDisableAndCaptureTimeout(t *testing.T) {
	directory := recorderTestDirectory(t)
	recorderTestConfig(t, directory, true)
	release := make(chan struct{})
	started := time.Now()
	err := runRecorder(context.Background(), directory, "boot", func(context.Context) (snapshotDTO, error) { <-release; return snapshotDTO{}, nil })
	close(release)
	if !errors.Is(err, errRecorderCaptureStalled) || time.Since(started) < 5*time.Second || time.Since(started) > 7*time.Second {
		t.Fatal("hung capture neither bounded nor recoverable", err, time.Since(started))
	}
	var state recordingRuntime
	if err := recorderReadJSON(filepath.Join(directory, "status.json"), &state); err != nil || state.Failures < 1 {
		t.Fatal("recovery backoff not persisted", state, err)
	}
	if recorderRecoveryDelay(1) != 5*time.Second || recorderRecoveryDelay(2) != 10*time.Second || recorderRecoveryDelay(1000) != 5*time.Minute {
		t.Fatal("unbounded recovery delay")
	}
	waited := make(chan bool, 1)
	go func() { waited <- recorderWaitRecovery(context.Background(), directory, 2*time.Second) }()
	time.Sleep(50 * time.Millisecond)
	recorderTestConfig(t, directory, false)
	select {
	case allowed := <-waited:
		if allowed {
			t.Fatal("explicit disable was ignored by pending replacement")
		}
	case <-time.After(time.Second):
		t.Fatal("pending recovery failed to stop")
	}
	recorderTestConfig(t, directory, true)
	if !recorderWaitRecovery(context.Background(), directory, 10*time.Millisecond) {
		t.Fatal("enabled recovery failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runRecorder(ctx, directory, "boot", func(context.Context) (snapshotDTO, error) {
			return snapshotDTO{Sequence: 1, SampledAt: time.Now().UnixMilli(), BootID: "boot", CPUCount: 1, Memory: memoryDTO{Total: 100, Used: 10}, Processes: []processDTO{}}, nil
		})
	}()
	defer cancel()
	deadline := time.Now().Add(time.Second)
	recovered := false
	for time.Now().Before(deadline) {
		var latest recordingRuntime
		if recorderReadJSON(filepath.Join(directory, "status.json"), &latest) == nil && latest.LastSampleAt != nil && latest.Failures == 0 {
			recovered = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !recovered {
		t.Fatal("a successful replacement never resumed recording")
	}
	recorderTestConfig(t, directory, false)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRecorderInitializationOwnsReservationAndHonorsDisable(t *testing.T) {
	directory := recorderTestDirectory(t)
	config := recorderTestConfig(t, directory, true)
	release := make(chan struct{})
	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runRecorderProcess(context.Background(), directory, func() (*collector, error) { close(entered); <-release; return &collector{}, nil })
	}()
	<-entered
	status, err := recorderGetStatus(directory)
	if err != nil || !status.Running || status.State != "starting" {
		t.Fatal("initialization has no live reservation", status, err)
	}
	secondInitialized := false
	if err := runRecorderProcess(context.Background(), directory, func() (*collector, error) { secondInitialized = true; return nil, nil }); err != nil || secondInitialized {
		t.Fatal("concurrent initialization allowed", err)
	}
	spawned := false
	_, err = recorderConfigure(context.Background(), directory, recordingConfigureParams{OperationID: "disable-initializer", ExpectedRevision: config.Revision, recordingSettings: recordingSettings{Enabled: false, IntervalSeconds: 1, RetentionDays: 7, MaxMiB: 256}}, func() error { spawned = true; return nil })
	if err != nil || spawned {
		t.Fatal("disable raced with initialization", err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("disabled initializer did not exit")
	}
	status, err = recorderGetStatus(directory)
	if err != nil || status.Running || status.Enabled {
		t.Fatal("initializer kept running after disable", status, err)
	}
}

func TestRecorderStatusWriteFailureRetriesAndEmptySegmentsAreRemoved(t *testing.T) {
	directory := recorderTestDirectory(t)
	recorderTestConfig(t, directory, true)
	statusPath := filepath.Join(directory, "status.json")
	if err := os.Mkdir(statusPath, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	called := make(chan struct{}, 2)
	go func() {
		done <- runRecorder(ctx, directory, "boot", func(context.Context) (snapshotDTO, error) {
			select {
			case called <- struct{}{}:
			default:
			}
			return snapshotDTO{Sequence: 1, SampledAt: time.Now().UnixMilli(), BootID: "boot", CPUCount: 1, Memory: memoryDTO{Total: 100, Used: 10}, Processes: []processDTO{}}, nil
		})
	}()
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("initial status write failure stopped capture")
	}
	if err := os.Remove(statusPath); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatal("transient status failure stopped recorder", err)
	case <-called:
	case <-time.After(6 * time.Second):
		t.Fatal("status failure was not retried")
	}
	recorderTestConfig(t, directory, false)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("recorder did not stop")
	}
	writer := recorderWriter{directory: directory}
	if err := writer.rotate(time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	base := writer.base
	writer.close()
	for _, suffix := range []string{".data", ".index"} {
		if _, err := os.Stat(filepath.Join(directory, base+suffix)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("empty failed segment retained")
		}
	}
}

func TestRecorderDanglingLockSymlinkDoesNotCreateOutsideTarget(t *testing.T) {
	directory := recorderTestDirectory(t)
	outside := filepath.Join(t.TempDir(), "outside-lock")
	path := filepath.Join(directory, "instance.lock")
	if err := os.Symlink(outside, path); err != nil {
		t.Skip("host does not permit symlink fixture")
	}
	if _, err := recorderTryLock(path); !recorderErrorIs(err, "UNSAFE_PATH") {
		t.Fatal("dangling lock link accepted", err)
	}
	if _, err := os.Stat(outside); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created an external lock target")
	}
}

func TestRecorderRetentionCorruptionAndGapBounds(t *testing.T) {
	directory := recorderTestDirectory(t)
	config := recorderDefaultConfig()
	config.RetentionDays = 1
	if err := recorderWriteJSON(filepath.Join(directory, "config.json"), config); err != nil {
		t.Fatal(err)
	}
	writer := recorderWriter{directory: directory}
	defer writer.close()
	old := recorderTestPoint(time.Now().Add(-48*time.Hour).UnixMilli(), 1, 10)
	if err := writer.append(&old, old.SampledAt, 0, 0, config.recordingSettings); err != nil {
		t.Fatal(err)
	}
	oldID := old.ID
	writer.close()
	now := time.Now().UnixMilli()
	point := recorderTestPoint(now, 2, 20)
	if err := writer.append(&point, now, now-60000, 2, config.recordingSettings); err != nil {
		t.Fatal(err)
	}
	if _, err := recorderReadPoint(directory, oldID); !recorderErrorIs(err, "HISTORY_NOT_FOUND") {
		t.Fatal("expired sample retained", err)
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: now - 60000, To: now, MaxPoints: 5})
	if err != nil || len(page.Gaps) != 1 || page.Gaps[0].Reason != "capture-failed" {
		t.Fatal("error gap lost", page, err)
	}
	for i := 0; i < 120; i++ {
		recorderAddGap(&page, now-50000+int64(i)*2000, now-49999+int64(i)*2000, fmt.Sprint(i))
	}
	if len(page.Gaps) > 100 {
		t.Fatal("gap list unbounded")
	}
	path := filepath.Join(directory, writer.base+".data")
	file, err := os.OpenFile(path, os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteAt([]byte("broken"), 0)
	file.Close()
	if _, err := recorderReadPoint(directory, point.ID); !recorderErrorIs(err, "HISTORY_CORRUPT") {
		t.Fatal("corrupt compressed record accepted", err)
	}
}

func TestRecorderDaemonStopsThroughConfigAndKeepsHistory(t *testing.T) {
	directory := recorderTestDirectory(t)
	recorderTestConfig(t, directory, true)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	var sequence uint64
	go func() {
		done <- runRecorder(ctx, directory, "test-boot", func(context.Context) (snapshotDTO, error) {
			sequence++
			return snapshotDTO{Sequence: sequence, SampledAt: time.Now().UnixMilli(), BootID: "test-boot", CPUCount: 1, Memory: memoryDTO{Total: 1000, Used: 100}, Processes: []processDTO{}}, nil
		})
	}()
	deadline := time.Now().Add(3 * time.Second)
	var status recordingStatus
	for time.Now().Before(deadline) {
		status, _ = recorderGetStatus(directory)
		if status.LastSampleAt != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !status.Running || status.LastSampleAt == nil || status.RecorderVersion != version {
		t.Fatal("recorder never became active", status)
	}
	_, err := runDuplicateRecorderForTest(directory)
	if err != nil {
		t.Fatal(err)
	}
	recorderTestConfig(t, directory, false)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("disable did not stop recorder")
	}
	status, err = recorderGetStatus(directory)
	if err != nil || status.Enabled || status.Running || status.State != "disabled" || status.StoredBytes == 0 {
		t.Fatal("disable destroyed history or kept running", status, err)
	}
	page, err := recorderQuery(context.Background(), directory, historyQuery{From: time.Now().Add(-time.Minute).UnixMilli(), To: time.Now().UnixMilli()})
	if err != nil || page.TotalSamples < 1 {
		t.Fatal("history lost after disable", err)
	}
}
func runDuplicateRecorderForTest(directory string) (bool, error) {
	called := false
	err := runRecorder(context.Background(), directory, "duplicate", func(context.Context) (snapshotDTO, error) { called = true; return snapshotDTO{}, nil })
	if called {
		return called, errors.New("second writer acquired lock")
	}
	return called, err
}

func TestRecorderChild(t *testing.T) {
	mode := os.Getenv("WEBNAV_TEST_RECORDER_MODE")
	if mode == "" {
		return
	}
	directory, err := recorderDirectory()
	if err != nil {
		os.Exit(2)
	}
	if mode == "launch" {
		command := exec.Command(os.Args[0], "-test.run=^TestRecorderChild$")
		command.Env = append(os.Environ(), "WEBNAV_TEST_RECORDER_MODE=record")
		null, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
		command.Stdin = null
		command.Stdout = null
		command.Stderr = null
		recorderDetach(command)
		if command.Start() != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	var sequence uint64
	err = runRecorder(ctx, directory, "child-boot", func(context.Context) (snapshotDTO, error) {
		sequence++
		return snapshotDTO{Sequence: sequence, SampledAt: time.Now().UnixMilli(), BootID: "child-boot", CPUCount: 1, Memory: memoryDTO{Total: 1000, Used: 100}, Processes: []processDTO{}}, nil
	})
	if err != nil {
		os.Exit(4)
	}
	os.Exit(0)
}

func TestRecorderDetachedChildOutlivesLauncher(t *testing.T) {
	home := t.TempDir()
	directory := filepath.Join(home, ".webnav", "tools", "task-manager", "recording-v1")
	if err := recorderCheckDirectory(directory, true); err != nil {
		t.Fatal(err)
	}
	recorderTestConfig(t, directory, true)
	defer recorderTestConfig(t, directory, false)
	command := exec.Command(os.Args[0], "-test.run=^TestRecorderChild$")
	command.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home, "WEBNAV_TEST_RECORDER_MODE=launch")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("isolated launcher: %v %s", err, output)
	}
	deadline := time.Now().Add(4 * time.Second)
	var first int64
	for time.Now().Before(deadline) {
		status, _ := recorderGetStatus(directory)
		if status.LastSampleAt != nil {
			if first == 0 {
				first = *status.LastSampleAt
			} else if *status.LastSampleAt > first {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	status, err := recorderGetStatus(directory)
	if err != nil || !status.Running || status.LastSampleAt == nil || *status.LastSampleAt <= first {
		t.Fatal("detached recorder did not survive launcher exit", status, err)
	}
	recorderTestConfig(t, directory, false)
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, _ = recorderGetStatus(directory)
		if !status.Running {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if status.Running {
		t.Fatal("isolated child did not stop; fixed 12s helper deadline will clean up")
	}
}
