package main

import (
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var gpuCommandJob struct {
	once   sync.Once
	handle windows.Handle
	err    error
}

func protectGPUCommand(_ *exec.Cmd) (func(), error) {
	gpuCommandJob.once.Do(func() {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			gpuCommandJob.err = err
			return
		}
		limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		// Only an explicitly detached persistent recorder may request breakaway.
		// Ordinary GPU tools never set CREATE_BREAKAWAY_FROM_JOB and stay owned.
		limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK
		_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
		if err == nil {
			// Assign this native collector BEFORE creating tools, so children are
			// members from birth. Never assign the Node host or any observed PID.
			err = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
		}
		if err != nil {
			windows.CloseHandle(job)
			gpuCommandJob.err = err
			return
		}
		// Keep this non-inheritable handle until OS process teardown. Explicitly
		// closing it here would also terminate the collector itself. OS closure
		// on a crash/force-kill reliably terminates all inherited child tools.
		gpuCommandJob.handle = job
	})
	if gpuCommandJob.err != nil {
		return nil, fmt.Errorf("protect GPU command process: %w", gpuCommandJob.err)
	}
	return func() {}, nil
}
