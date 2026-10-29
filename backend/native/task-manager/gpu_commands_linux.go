package main

import (
	"os/exec"
	"runtime"
	"syscall"
)

func protectGPUCommand(command *exec.Cmd) (func(), error) {
	// Linux parent-death signals follow the thread that created the process,
	// not simply its process ID. Keep that OS thread alive through Start/Wait;
	// otherwise a Go thread retirement could kill a healthy tool prematurely.
	runtime.LockOSThread()
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Pdeathsig = syscall.SIGKILL
	return runtime.UnlockOSThread, nil
}
