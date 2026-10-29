package main

import (
	"context"
	"encoding/csv"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// TCC/MCDM compute devices do not participate in WDDM's display counters.
// Use only NVIDIA's two documented installation locations, never PATH.
func nvidiaComputeBinaryWindows() string {
	systemDirectory, _ := windows.GetSystemDirectory()
	programFiles, _ := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	return nvidiaComputeBinaryAt(systemDirectory, programFiles)
}

func nvidiaComputeBinaryAt(systemDirectory, programFiles string) string {
	paths := []string{}
	if systemDirectory != "" {
		paths = append(paths, filepath.Join(systemDirectory, "nvidia-smi.exe"))
	}
	if programFiles != "" {
		paths = append(paths, filepath.Join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"))
	}
	for _, binary := range paths {
		if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() {
			return binary
		}
	}
	return ""
}

func collectNvidiaComputeWindows(ctx context.Context) ([]gpuDTO, []string) {
	binary := nvidiaComputeBinaryWindows()
	if binary == "" {
		return nil, nil
	}
	deadline, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
	defer cancel()
	command := exec.CommandContext(deadline, binary, "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,driver_model.current", "--format=csv,noheader,nounits")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, diagnostics := &gpuBuffer{limit: maxGPUBytes}, &gpuBuffer{limit: 4096}
	command.Stdout, command.Stderr = output, diagnostics
	command.WaitDelay = 100 * time.Millisecond
	if err := runGPUCommand(command); err != nil {
		return nil, []string{"gpu:nvidia-compute-unavailable"}
	}
	return parseNvidiaComputeWindows(output.data, time.Now().UnixMilli())
}

func parseNvidiaComputeWindows(data []byte, sampledAt int64) ([]gpuDTO, []string) {
	if len(data) > maxGPUBytes {
		return nil, []string{"gpu:nvidia-output-limit"}
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = 7
	var rows strings.Builder
	writer := csv.NewWriter(&rows)
	for count := 0; ; count++ {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, []string{"gpu:nvidia-invalid-output"}
		}
		if count >= maxGPUs {
			return nil, []string{"gpu:truncated"}
		}
		// Explicit compute mode avoids duplicating WDDM cards or joining by name.
		mode := strings.TrimSpace(row[6])
		if mode == "TCC" || mode == "MCDM" {
			_ = writer.Write(row[:6])
		}
	}
	writer.Flush()
	devices, missing := parseNvidiaGPU([]byte(rows.String()), sampledAt)
	for i := range devices {
		devices[i].Source = "nvidia-smi-compute"
		devices[i].UtilizationScope = "device"
	}
	return devices, missing
}
