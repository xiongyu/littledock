package main

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func configureGPUTestCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func gpuTestProcessAlive(pid int) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err != windows.ERROR_INVALID_PARAMETER
	}
	defer windows.CloseHandle(process)
	status, err := windows.WaitForSingleObject(process, 0)
	return err != nil || status != windows.WAIT_OBJECT_0
}
