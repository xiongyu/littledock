package main

import (
	"context"
	"strings"
	"unsafe"

	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/sys/windows"
)

func platformProcesses(ctx context.Context) ([]int32, map[int32]*processMetadata, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, nil, err
	}
	defer windows.CloseHandle(snapshot)
	pids := []int32{}
	metadata := make(map[int32]*processMetadata)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	err = windows.Process32First(snapshot, &entry)
	for err == nil && ctx.Err() == nil {
		pid := int32(entry.ProcessID)
		pids = append(pids, pid)
		metadata[pid] = &processMetadata{name: windows.UTF16ToString(entry.ExeFile[:]), ppid: int32(entry.ParentProcessID), threads: int32(entry.Threads)}
		err = windows.Process32Next(snapshot, &entry)
	}
	if err != nil && err != windows.ERROR_NO_MORE_FILES {
		return nil, nil, err
	}
	return pids, metadata, nil
}
func platformDetails(ctx context.Context, p *process.Process, d *detailsDTO) {
	// Avoid global NT handle walks and blocking duplicated file handles. A
	// bounded Windows handle collector is a separate capability.
	d.Unavailable = append(d.Unavailable, "files")
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPMODULE|windows.TH32CS_SNAPMODULE32, uint32(p.Pid))
	if err != nil {
		d.Unavailable = append(d.Unavailable, "modules")
	} else {
		var entry windows.ModuleEntry32
		entry.Size = uint32(unsafe.Sizeof(entry))
		err = windows.Module32First(snapshot, &entry)
		for err == nil && ctx.Err() == nil {
			if len(d.Modules) >= maxDetails {
				d.Unavailable = append(d.Unavailable, "modules:truncated")
				break
			}
			d.Modules = append(d.Modules, bounded(windows.UTF16ToString(entry.ExePath[:])))
			err = windows.Module32Next(snapshot, &entry)
		}
		if err != nil && err != windows.ERROR_NO_MORE_FILES {
			d.Unavailable = append(d.Unavailable, "modules")
		}
		windows.CloseHandle(snapshot)
	}
	snapshot, err = windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		d.Unavailable = append(d.Unavailable, "threads")
	} else {
		var entry windows.ThreadEntry32
		entry.Size = uint32(unsafe.Sizeof(entry))
		err = windows.Thread32First(snapshot, &entry)
		for err == nil && ctx.Err() == nil {
			if entry.OwnerProcessID == uint32(p.Pid) {
				if len(d.Threads) >= maxDetails {
					d.Unavailable = append(d.Unavailable, "threads:truncated")
					break
				}
				d.Threads = append(d.Threads, threadDTO{ID: int32(entry.ThreadID)})
			}
			err = windows.Thread32Next(snapshot, &entry)
		}
		if err != nil && err != windows.ERROR_NO_MORE_FILES {
			d.Unavailable = append(d.Unavailable, "threads")
		}
		windows.CloseHandle(snapshot)
	}
}
func terminatePlatform(ctx context.Context, p *process.Process, identity identityParams, force bool) error {
	if !force {
		return fail("UNSUPPORTED", "Windows requires an explicit force termination choice")
	}
	name, _ := p.NameWithContext(ctx)
	switch strings.ToLower(name) {
	case "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe", "dwm.exe":
		return fail("PROTECTED_PROCESS", "System processes cannot be terminated")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(p.Pid))
	if err != nil {
		return fail("PERMISSION_DENIED", "Process cannot be opened with current permissions")
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return fail("PROCESS_UNAVAILABLE", "Process identity cannot be verified")
	}
	if created.Nanoseconds()/1000000 != identity.StartedAt {
		return fail("IDENTITY_MISMATCH", "Process identity changed; refresh before continuing")
	}
	criticalAPI := windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessCritical")
	if err = criticalAPI.Find(); err != nil {
		return fail("UNSUPPORTED", "Critical process protection is unavailable on this Windows version")
	}
	var critical int32
	success, _, _ := criticalAPI.Call(uintptr(handle), uintptr(unsafe.Pointer(&critical)))
	if success == 0 {
		return fail("PROCESS_UNAVAILABLE", "Critical process status cannot be verified")
	}
	if critical != 0 {
		return fail("PROTECTED_PROCESS", "System-critical processes cannot be terminated")
	}
	// The creation check and termination use the same OS handle, so PID reuse
	// cannot redirect a confirmed operation to a different process.
	if err = windows.TerminateProcess(handle, 1); err != nil {
		return fail("PERMISSION_DENIED", "Process could not be terminated with current permissions")
	}
	return nil
}
