package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsNvidiaComputeDoesNotDuplicateDisplayAdapters(t *testing.T) {
	devices, _ := parseNvidiaComputeWindows([]byte("GPU-1, Same model, 80, 1024, 8192, 50, WDDM\nGPU-2, Same model, 70, 2048, 16384, 48, TCC\nGPU-3, MCDM adapter, 12, 4096, 16384, 60, MCDM\nGPU-4, Unknown mode, 12, 4096, 16384, 60, N/A\n"), 100)
	if len(devices) != 2 || devices[0].ID != "nvidia:GPU-2" || *devices[0].UtilizationPercent != 70 || *devices[0].MemoryUsedBytes != 2048*1024*1024 || devices[0].Source != "nvidia-smi-compute" || devices[1].ID != "nvidia:GPU-3" {
		t.Fatalf("incorrect compute-mode collection: %+v", devices)
	}
	devices, missing := parseNvidiaComputeWindows([]byte("GPU-2, Test, N/A, N/A, 16384, N/A, TCC\n"), 100)
	if len(devices) != 1 || devices[0].UtilizationPercent != nil || len(missing) == 0 {
		t.Fatal("missing compute counters became zero")
	}
}

func TestWindowsNvidiaComputeUsesOnlyDocumentedLocations(t *testing.T) {
	root := t.TempDir()
	system := filepath.Join(root, "System32")
	programs := filepath.Join(root, "Program Files")
	nvsmi := filepath.Join(programs, "NVIDIA Corporation", "NVSMI")
	for _, path := range []string{system, nvsmi} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if nvidiaComputeBinaryAt(system, programs) != "" || nvidiaComputeBinaryAt("", "") != "" {
		t.Fatal("missing tool resolved outside the fixed directories")
	}
	legacy := filepath.Join(nvsmi, "nvidia-smi.exe")
	if err := os.WriteFile(legacy, []byte("test fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	if nvidiaComputeBinaryAt(system, programs) != legacy {
		t.Fatal("non-DCH driver location was not found")
	}
	modern := filepath.Join(system, "nvidia-smi.exe")
	if err := os.WriteFile(modern, []byte("test fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	if nvidiaComputeBinaryAt(system, programs) != modern {
		t.Fatal("System32 should remain the first fixed location")
	}
}
