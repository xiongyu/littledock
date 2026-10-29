package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var errRecorderCaptureStalled = errors.New("recording capture requires isolated recovery")

func recorderRecoveryDelay(failures int) time.Duration {
	if failures < 1 {
		failures = 1
	}
	if failures > 7 {
		failures = 7
	}
	delay := 5 * time.Second * time.Duration(1<<uint(failures-1))
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	return delay
}
func recorderWaitRecovery(ctx context.Context, directory string, delay time.Duration) bool {
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if err != nil {
		return false
	}
	defer unlock()
	var state recordingRuntime
	_ = recorderReadJSON(filepath.Join(directory, "status.json"), &state)
	state.InstanceID = recorderToken()
	state.PID = os.Getpid()
	state.State = "starting"
	state.RecorderVersion = version
	deadline := time.Now().Add(delay)
	beat := time.Time{}
	for {
		config, err := recorderLoadConfig(directory)
		if err != nil || !config.Enabled || ctx.Err() != nil {
			return false
		}
		if !time.Now().Before(deadline) {
			return true
		}
		if time.Since(beat) > 2*time.Second {
			state.UpdatedAt = time.Now().UnixMilli()
			_ = recorderWriteJSON(filepath.Join(directory, "status.json"), state)
			beat = time.Now()
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// runRecorder owns only recording files and its own metric helper processes.
// It has no stdin heartbeat, network listener, arbitrary command or process
// action API. Configuration writes, not PID signals, request a graceful stop.
func runRecorder(ctx context.Context, directory, bootID string, capture func(context.Context) (snapshotDTO, error)) error {
	if err := recorderCheckDirectory(directory, true); err != nil {
		return err
	}
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unlock()
	return runRecorderOwned(ctx, directory, bootID, capture)
}

func runRecorderOwned(ctx context.Context, directory, bootID string, capture func(context.Context) (snapshotDTO, error)) error {
	config, err := recorderLoadConfig(directory)
	if err != nil || !config.Enabled {
		return err
	}
	instance := recorderToken()
	if instance == "" {
		return errors.New("recording identity unavailable")
	}
	state := recordingRuntime{InstanceID: instance, PID: os.Getpid(), BootID: bootID, State: "starting", UpdatedAt: time.Now().UnixMilli(), RecorderVersion: version}
	var previous recordingRuntime
	if recorderReadJSON(filepath.Join(directory, "status.json"), &previous) == nil {
		state.LastSampleAt = previous.LastSampleAt
		state.Failures = previous.Failures
		if state.Failures < 0 || state.Failures > 100 {
			state.Failures = 0
		}
	}
	writeState := func() error {
		state.UpdatedAt = time.Now().UnixMilli()
		return recorderWriteJSON(filepath.Join(directory, "status.json"), state)
	}
	if err := writeState(); err != nil {
		state.State = "error"
		state.LastError = "RECORDING_STORAGE_FAILED"
	}
	writer := recorderWriter{directory: directory}
	if state.LastSampleAt != nil {
		writer.lastAt = *state.LastSampleAt
	}
	defer writer.close()
	defer func() {
		state.State = "stopped"
		if !config.Enabled {
			state.State = "disabled"
		}
		_ = writeState()
	}()
	next := time.Now()
	lastBeat := time.Now()
	gapCode := uint32(0)
	var gapFrom int64
	if state.LastSampleAt != nil {
		gapFrom = *state.LastSampleAt + int64(config.IntervalSeconds)*1000
		gapCode = 4
	}
	for {
		if ctx.Err() != nil {
			state.LastError = "RECORDING_INTERRUPTED"
			return nil
		}
		loaded, err := recorderLoadConfig(directory)
		if err != nil {
			state.LastError = "RECORDING_STORAGE_FAILED"
			return err
		}
		config = loaded
		if !config.Enabled {
			state.LastError = ""
			return nil
		}
		if time.Now().Before(next) {
			if time.Since(lastBeat) >= 2*time.Second {
				if err := writeState(); err != nil {
					state.State = "error"
					state.LastError = "RECORDING_STORAGE_FAILED"
				}
				lastBeat = time.Now()
			}
			select {
			case <-ctx.Done():
				continue
			case <-time.After(200 * time.Millisecond):
				continue
			}
		}
		started := time.Now()
		captureContext, cancel := context.WithTimeout(ctx, 5*time.Second)
		type captureResult struct {
			snapshot snapshotDTO
			err      error
		}
		completed := make(chan captureResult, 1)
		go func() { snapshot, err := capture(captureContext); completed <- captureResult{snapshot, err} }()
		var result captureResult
		timedOut := false
		select {
		case result = <-completed:
		case <-captureContext.Done():
			result.err = captureContext.Err()
			timedOut = true
		}
		cancel()
		now := time.Now().UnixMilli()
		interval := int64(config.IntervalSeconds) * 1000
		if gapFrom == 0 && state.LastSampleAt != nil && now > *state.LastSampleAt+interval+1500 {
			gapFrom = *state.LastSampleAt + interval
			gapCode = 1
		}
		if result.err != nil {
			state.State = "error"
			state.LastError = "RECORDING_CAPTURE_FAILED"
			if gapFrom == 0 {
				gapFrom = started.UnixMilli()
			}
			gapCode = 2
			if err := writer.append(nil, now, gapFrom, gapCode, config.recordingSettings); err != nil {
				state.LastError = "RECORDING_STORAGE_FAILED"
				gapCode = 3
			}
		} else {
			point := recorderPoint(result.snapshot, config.IntervalSeconds)
			// Snapshot wall time can precede the previous point after a clock
			// adjustment. Segments rotate; the query sorts actual timestamps.
			if gapFrom > point.SampledAt {
				gapFrom = 0
				gapCode = 0
			}
			if err := writer.append(&point, point.SampledAt, gapFrom, gapCode, config.recordingSettings); err != nil {
				state.State = "error"
				state.LastError = "RECORDING_STORAGE_FAILED"
				if gapFrom == 0 {
					gapFrom = started.UnixMilli()
				}
				gapCode = 3
			} else {
				state.State = "recording"
				state.LastError = ""
				state.Failures = 0
				at := point.SampledAt
				state.LastSampleAt = &at
				gapFrom = 0
				gapCode = 0
			}
		}
		if state.LastError != "" && state.Failures < 100 {
			state.Failures++
		}
		if err := writeState(); err != nil {
			state.State = "error"
			state.LastError = "RECORDING_STORAGE_FAILED"
			if state.Failures < 100 {
				state.Failures++
			}
		}
		lastBeat = time.Now()
		if timedOut {
			if ctx.Err() != nil {
				return nil
			}
			return errRecorderCaptureStalled
		} // Never queue another worker behind a stuck OS read.
		next = started.Add(time.Duration(config.IntervalSeconds) * time.Second)
		if state.LastError != "" {
			next = time.Now().Add(recorderRecoveryDelay(state.Failures))
		}
		if !next.After(time.Now()) {
			next = time.Now().Add(100 * time.Millisecond)
		}
	}
}

func runRecorderProcess(ctx context.Context, directory string, initialize func() (*collector, error)) error {
	if err := recorderCheckDirectory(directory, true); err != nil {
		return err
	}
	unlock, err := recorderTryLock(filepath.Join(directory, "instance.lock"))
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unlock()
	config, err := recorderLoadConfig(directory)
	if err != nil || !config.Enabled {
		return err
	}
	var state recordingRuntime
	_ = recorderReadJSON(filepath.Join(directory, "status.json"), &state)
	state.InstanceID = recorderToken()
	state.PID = os.Getpid()
	state.State = "starting"
	state.UpdatedAt = time.Now().UnixMilli()
	state.RecorderVersion = version
	_ = recorderWriteJSON(filepath.Join(directory, "status.json"), state)
	type initialized struct {
		collector *collector
		err       error
	}
	result := make(chan initialized, 1)
	go func() { value, err := initialize(); result <- initialized{value, err} }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	var value initialized
	select {
	case value = <-result:
	case <-ctx.Done():
		return nil
	case <-deadline.C:
		value.err = errRecorderCaptureStalled
	}
	if value.err != nil || value.collector == nil {
		state.State = "error"
		state.LastError = "RECORDING_CAPTURE_FAILED"
		if state.Failures < 100 {
			state.Failures++
		}
		state.UpdatedAt = time.Now().UnixMilli()
		_ = recorderWriteJSON(filepath.Join(directory, "status.json"), state)
		return errRecorderCaptureStalled
	}
	return runRecorderOwned(ctx, directory, value.collector.hello.BootID, func(ctx context.Context) (snapshotDTO, error) {
		snapshot, err := value.collector.snapshot(ctx)
		if err != nil {
			return snapshotDTO{}, err
		}
		return *snapshot, nil
	})
}

func runRecorderMode(recovery bool) {
	directory, err := recorderDirectory()
	if err != nil {
		return
	}
	if err := recorderCheckDirectory(directory, false); err != nil {
		return
	}
	config, err := recorderLoadConfig(directory)
	if err != nil || !config.Enabled {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The recorder deliberately survives an SSH hangup. A logout policy can
	// still send TERM/KILL; never modify that policy or register auto-start.
	signal.Ignore(syscall.SIGHUP)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			cancel()
		case <-ctx.Done():
		}
	}()
	if recovery {
		var previous recordingRuntime
		_ = recorderReadJSON(filepath.Join(directory, "status.json"), &previous)
		if !recorderWaitRecovery(ctx, directory, recorderRecoveryDelay(previous.Failures)) {
			return
		}
	}
	err = runRecorderProcess(ctx, directory, newCollector)
	if errors.Is(err, errRecorderCaptureStalled) && ctx.Err() == nil {
		config, readErr := recorderLoadConfig(directory)
		if readErr != nil || !config.Enabled {
			return
		}
		executable, executableErr := os.Executable()
		if executableErr != nil {
			return
		}
		// One detached successor, no growing queue behind the stuck goroutine.
		// main now exits, releasing that goroutine and its owned GPU tools.
		if recorderSpawnMode(executable, "--record-recover") != nil {
			var state recordingRuntime
			if recorderReadJSON(filepath.Join(directory, "status.json"), &state) == nil {
				state.State = "error"
				state.LastError = "RECORDING_START_FAILED"
				state.UpdatedAt = time.Now().UnixMilli()
				_ = recorderWriteJSON(filepath.Join(directory, "status.json"), state)
			}
		}
	}
}
