package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func gpuTestHelper(mode, pidPath string) *exec.Cmd {
	command := exec.Command(os.Args[0], "-test.run=^TestGPUCommandHelper$")
	command.Env = append(os.Environ(), "WEBNAV_GPU_TEST_HELPER="+mode, "WEBNAV_GPU_TEST_PID="+pidPath)
	configureGPUTestCommand(command)
	return command
}

// Child processes use only temporary test-owned paths and never call a driver.
func TestGPUCommandHelper(t *testing.T) {
	mode := os.Getenv("WEBNAV_GPU_TEST_HELPER")
	if mode == "" {
		return
	}
	pidPath := os.Getenv("WEBNAV_GPU_TEST_PID")
	if mode == "child" {
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(2)
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	if mode == "supervisor" {
		done := make(chan error, 1)
		go func() { done <- runGPUCommand(gpuTestHelper("child", pidPath)) }()
		_, _ = io.Copy(io.Discard, os.Stdin)
		closeGPUCommands()
		select {
		case <-done:
			os.Exit(0)
		case <-time.After(time.Second):
			os.Exit(3)
		}
	}
	os.Exit(4)
}

func waitGPUTestPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			if pid, err := strconv.Atoi(string(data)); err == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("owned GPU helper did not report ready")
	return 0
}

func waitGPUTestExit(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !gpuTestProcessAlive(pid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("owned GPU child %d survived its collector", pid)
}

func TestGPUCommandShutdownKillsRegisteredChildAndRejectsNewStarts(t *testing.T) {
	registry := &gpuCommandRegistry{}
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	command := gpuTestHelper("child", pidPath)
	done := make(chan error, 1)
	go func() { done <- registry.run(command) }()
	t.Cleanup(registry.close)
	pid := waitGPUTestPID(t, pidPath)
	started := time.Now()
	registry.close()
	if time.Since(started) > 750*time.Millisecond {
		t.Fatal("GPU command cleanup exceeded its bounded wait")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("blocking helper unexpectedly completed without termination")
		}
	case <-time.After(time.Second):
		t.Fatal("registered helper was not reaped")
	}
	waitGPUTestExit(t, pid)
	registry.close()
	late := gpuTestHelper("child", filepath.Join(t.TempDir(), "late.pid"))
	if err := registry.run(late); !errors.Is(err, errGPUCommandsClosed) || late.Process != nil {
		t.Fatal("shutdown allowed a new GPU tool to start")
	}
}

func TestGPUCommandEOFReleasesOwnedChild(t *testing.T) {
	testGPUCommandSupervisorExit(t, false)
}

func TestGPUCommandShutdownDoesNotWaitForeverForInFlightStart(t *testing.T) {
	registry := &gpuCommandRegistry{}
	registry.initialize()
	<-registry.gate // Represents an OS Start call that has not returned.
	started := time.Now()
	registry.close()
	if time.Since(started) > 750*time.Millisecond || !registry.closing.Load() {
		t.Fatal("shutdown blocked on process creation instead of marking closed")
	}
	registry.gate <- struct{}{}
	command := gpuTestHelper("child", filepath.Join(t.TempDir(), "never-started.pid"))
	if err := registry.run(command); !errors.Is(err, errGPUCommandsClosed) || command.Process != nil {
		t.Fatal("shutdown raced with a later process start")
	}
}

func TestGPUCommandForcedCollectorExitReleasesOwnedChild(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS has no parent-death process primitive; normal EOF is separately tested")
	}
	testGPUCommandSupervisorExit(t, true)
}

func testGPUCommandSupervisorExit(t *testing.T, force bool) {
	t.Helper()
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	supervisor := gpuTestHelper("supervisor", pidPath)
	input, err := supervisor.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = supervisor.Process.Kill() })
	pid := waitGPUTestPID(t, pidPath)
	if force {
		if err := supervisor.Process.Kill(); err != nil {
			t.Fatal(err)
		}
	} else if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- supervisor.Wait() }()
	select {
	case err := <-waited:
		if !force && err != nil {
			t.Fatalf("normal EOF cleanup failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("test collector did not exit")
	}
	waitGPUTestExit(t, pid)
}
