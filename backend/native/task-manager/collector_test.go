package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

func testCollector(t *testing.T) *collector {
	t.Helper()
	c, err := newCollector()
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var public *publicError
	if !errors.As(err, &public) || public.Code != code {
		t.Fatalf("expected %s, received %v", code, err)
	}
}
func TestProtocolValidation(t *testing.T) {
	c := testCollector(t)
	for _, input := range []string{`{"v":1,"id":"one","method":"ping","params":{},"extra":true}`, `{"v":2,"id":"one","method":"hello"}`} {
		var output bytes.Buffer
		serve(strings.NewReader(input+"\n"), &output, c, time.Second)
		var response response
		if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
			t.Fatal(err)
		}
		if response.OK || response.Error.Code != "INVALID_REQUEST" {
			t.Fatalf("unexpected response: %s", output.String())
		}
	}
	for _, params := range []string{`{"shell":"whoami"}`, `null`} {
		_, err := c.dispatch(context.Background(), request{V: 1, ID: "validation", Method: "ping", Params: json.RawMessage(params)})
		assertCode(t, err, "INVALID_REQUEST")
	}
	var output bytes.Buffer
	serve(strings.NewReader(strings.Repeat("x", maxRequestBytes+5)+"\n"), &output, c, time.Second)
	if !strings.Contains(output.String(), "REQUEST_TOO_LARGE") {
		t.Fatalf("oversized request not rejected: %s", output.String())
	}
}
func TestProtocolStopAndIdle(t *testing.T) {
	c := testCollector(t)
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan struct{})
	go func() { serve(inReader, outWriter, c, time.Second); _ = outWriter.Close(); close(done) }()
	_, _ = io.WriteString(inWriter, "{\"v\":1,\"id\":\"test\",\"method\":\"stop\",\"params\":{}}\n")
	line, err := bufio.NewReader(outReader).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, `"stopped":true`) {
		t.Fatal(line)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stop did not exit")
	}
	_ = inWriter.Close()
	_ = inReader.Close()
	_ = outReader.Close()
	idleReader, idleWriter := io.Pipe()
	defer idleReader.Close()
	defer idleWriter.Close()
	started := time.Now()
	serve(idleReader, io.Discard, c, 25*time.Millisecond)
	if time.Since(started) > time.Second {
		t.Fatal("idle cleanup stalled")
	}
	serve(strings.NewReader(""), io.Discard, c, time.Second)
}
func TestSnapshotByteBound(t *testing.T) {
	s := &snapshotDTO{Processes: make([]processDTO, maxProcesses), Capabilities: []string{"processes"}}
	s.Performance = &performanceDTO{CPULogical: make([]logicalCPUDTO, maxLogicalCPUs), Disks: make([]diskDTO, maxDisks), GPUs: make([]gpuDTO, maxGPUs), Unavailable: []string{}}
	for index := range s.Performance.CPULogical {
		s.Performance.CPULogical[index] = logicalCPUDTO{ID: index}
	}
	for index := range s.Performance.Disks {
		s.Performance.Disks[index] = diskDTO{ID: fmt.Sprint(index), Name: strings.Repeat("\x01", 256)}
	}
	for index := range s.Performance.GPUs {
		s.Performance.GPUs[index] = gpuDTO{ID: fmt.Sprint(index), Name: strings.Repeat("\x01", 256), Source: "test"}
	}
	for i := range s.Processes {
		s.Processes[i] = processDTO{PID: int32(i + 1), StartedAt: 1, Name: strings.Repeat("界", 600), Executable: strings.Repeat("界", 600)}
	}
	boundSnapshot(s)
	encoded := encodeResponse(strings.Repeat("a", 128), s, nil)
	if len(encoded) > maxResponseBytes || !s.Truncated || len(s.Processes) == maxProcesses || len(s.Processes) == 0 {
		t.Fatalf("invalid bound %d bytes / %d processes", len(encoded), len(s.Processes))
	}
	var envelope response
	if err := json.Unmarshal(encoded, &envelope); err != nil || !envelope.OK {
		t.Fatal("bounded snapshot did not encode successfully")
	}
	if len(s.Performance.CPULogical) != maxLogicalCPUs || len(s.Performance.Disks) != maxDisks || len(s.Performance.GPUs) != maxGPUs {
		t.Fatal("performance arrays were silently dropped while bounding processes")
	}
}
func TestLiveSnapshotAndIdentity(t *testing.T) {
	c := testCollector(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	start := time.Now()
	snapshot, err := c.snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Sequence != 1 || snapshot.Memory.Total == 0 || len(snapshot.Processes) == 0 || snapshot.BootID == "" {
		t.Fatal("invalid live snapshot")
	}
	t.Logf("snapshot: %d visible processes, truncated=%t, elapsed=%s", len(snapshot.Processes), snapshot.Truncated, time.Since(start))
	start = time.Now()
	second, err := c.snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("cached snapshot: %d visible processes, elapsed=%s", len(second.Processes), time.Since(start))
	if snapshot.Performance == nil || second.Performance == nil {
		t.Fatal("missing performance sample")
	}
	if len(snapshot.Performance.CPULogical) > maxLogicalCPUs || len(snapshot.Performance.Disks) > maxDisks || len(snapshot.Performance.GPUs) > maxGPUs {
		t.Fatal("performance bounds exceeded")
	}
	for _, core := range snapshot.Performance.CPULogical {
		if core.UsagePercent != nil {
			t.Fatal("first CPU interval was fabricated")
		}
	}
	for _, device := range snapshot.Performance.Disks {
		if device.ReadBytesPerSecond != nil || device.WriteBytesPerSecond != nil || device.ActivePercent != nil {
			t.Fatal("first disk interval was fabricated")
		}
	}
	t.Logf("performance: logical=%d disks=%d GPUs=%d unavailable=%v", len(second.Performance.CPULogical), len(second.Performance.Disks), len(second.Performance.GPUs), second.Performance.Unavailable)
	for _, device := range second.Performance.Disks {
		data, _ := json.Marshal(device)
		t.Logf("physical disk: %s", data)
	}
	p, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	created, err := p.CreateTime()
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.details(ctx, identityParams{p.Pid, created + 1})
	assertCode(t, err, "IDENTITY_MISMATCH")
	force := true
	_, err = c.terminate(ctx, terminateParams{p.Pid, created, &force})
	assertCode(t, err, "PROTECTED_PROCESS")
	details, err := c.details(ctx, identityParams{p.Pid, created})
	if err != nil {
		t.Fatal(err)
	}
	if len(details.Files) > maxDetails || len(details.Threads) > maxDetails || len(details.Modules) > maxDetails || len(details.Connections) > maxDetails {
		t.Fatal("detail bound exceeded")
	}
	t.Logf("details: files=%d modules=%d threads=%d network=%d unavailable=%v", len(details.Files), len(details.Modules), len(details.Threads), len(details.Connections), details.Unavailable)
}
func TestCollectorChild(t *testing.T) {
	if os.Getenv("WEBNAV_COLLECTOR_TEST_CHILD") != "1" {
		return
	}
	time.Sleep(time.Minute)
	os.Exit(0)
}
func TestTerminateDedicatedChild(t *testing.T) {
	c := testCollector(t)
	child := exec.Command(os.Args[0], "-test.run=^TestCollectorChild$")
	child.Env = append(os.Environ(), "WEBNAV_COLLECTOR_TEST_CHILD=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	p, err := process.NewProcess(int32(child.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	started, err := p.CreateTime()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	force := true
	_, err = c.terminate(ctx, terminateParams{p.Pid, started + 1, &force})
	assertCode(t, err, "IDENTITY_MISMATCH")
	if exists, _ := process.PidExists(p.Pid); !exists {
		t.Fatal("identity mismatch terminated child")
	}
	result, err := c.terminate(ctx, terminateParams{p.Pid, started, &force})
	if runtime.GOOS == "darwin" {
		assertCode(t, err, "UNSUPPORTED")
		if exists, _ := process.PidExists(p.Pid); !exists {
			t.Fatal("unsupported action terminated child")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "exited" && result.Status != "pending" {
		t.Fatalf("unexpected status %s", result.Status)
	}
	if err = child.Wait(); err == nil {
		t.Fatal("expected child termination exit code")
	}
	if exists, _ := process.PidExists(p.Pid); exists {
		t.Fatal("dedicated child did not exit")
	}
}
