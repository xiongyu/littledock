package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

func commandLineError(err error) error {
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.STATUS_ACCESS_DENIED) {
		return os.ErrPermission
	}
	return err
}
func platformCommandLine(ctx context.Context, p *process.Process) (string, bool, error) {
	if ctx.Err() != nil {
		return "", false, ctx.Err()
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(p.Pid))
	if err != nil {
		return "", false, commandLineError(err)
	}
	defer windows.CloseHandle(handle)
	var size uint32
	err = windows.NtQueryInformationProcess(handle, windows.ProcessCommandLineInformation, nil, 0, &size)
	if err != nil && !errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) && !errors.Is(err, windows.STATUS_BUFFER_OVERFLOW) && !errors.Is(err, windows.STATUS_BUFFER_TOO_SMALL) {
		return "", false, commandLineError(err)
	}
	headerSize := uint32(unsafe.Sizeof(windows.NTUnicodeString{}))
	if size < headerSize || size > 128*1024 {
		return "", false, fmt.Errorf("command line size unavailable")
	}
	buffer := make([]byte, size)
	err = windows.NtQueryInformationProcess(handle, windows.ProcessCommandLineInformation, unsafe.Pointer(&buffer[0]), size, &size)
	if err != nil {
		return "", false, commandLineError(err)
	}
	header := (*windows.NTUnicodeString)(unsafe.Pointer(&buffer[0]))
	if header.Length == 0 {
		return "", false, nil
	}
	start := uintptr(unsafe.Pointer(&buffer[0]))
	address := uintptr(unsafe.Pointer(header.Buffer))
	length := uintptr(header.Length)
	if length%2 != 0 || address < start+uintptr(headerSize) || address-start > uintptr(len(buffer)) || length > uintptr(len(buffer))-(address-start) {
		return "", false, fmt.Errorf("command line buffer unavailable")
	}
	// The buffer belongs to this query, not a pointer into the target process.
	text := windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[int(address-start)])), int(length/2)))
	return text, false, nil
}
