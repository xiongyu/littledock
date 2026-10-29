package main

import (
	"context"
	"encoding/binary"
	"sort"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DISK_PERFORMANCE (winioctl.h). Device counters are sampled from PhysicalDrive,
// never copied from a filesystem volume or summed across partitions.
type nativeDiskPerformance struct {
	BytesRead           int64
	BytesWritten        int64
	ReadTime            int64
	WriteTime           int64
	IdleTime            int64
	ReadCount           uint32
	WriteCount          uint32
	QueueDepth          uint32
	SplitCount          uint32
	QueryTime           int64
	StorageDeviceNumber uint32
	StorageManagerName  [8]uint16
}

func physicalDriveNumber(name string) (uint64, bool) {
	value, ok := strings.CutPrefix(name, "PhysicalDrive")
	if !ok || value == "" {
		return 0, false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	number, err := strconv.ParseUint(value, 10, 32)
	return number, err == nil
}
func windowsPhysicalDrives() ([]string, error) {
	for size := 4096; size <= 131072; size *= 2 {
		buffer := make([]uint16, size)
		count, err := windows.QueryDosDevice(nil, &buffer[0], uint32(len(buffer)))
		if err == windows.ERROR_INSUFFICIENT_BUFFER {
			continue
		}
		if err != nil {
			return nil, err
		}
		names := []string{}
		seen := make(map[string]bool)
		start := 0
		for index := 0; index < int(count); index++ {
			if buffer[index] != 0 {
				continue
			}
			name := windows.UTF16ToString(buffer[start:index])
			start = index + 1
			if _, ok := physicalDriveNumber(name); ok && !seen[name] {
				names = append(names, name)
				seen[name] = true
			}
		}
		sort.Slice(names, func(i, j int) bool {
			a, _ := physicalDriveNumber(names[i])
			b, _ := physicalDriveNumber(names[j])
			return a < b
		})
		return names, nil
	}
	return nil, windows.ERROR_INSUFFICIENT_BUFFER
}
func windowsDiskCounter(name string) diskCounter {
	row := diskCounter{ID: strings.ToLower(name), Name: name, SampledAt: time.Now()}
	path, err := windows.UTF16PtrFromString(`\\.\` + name)
	if err != nil {
		return row
	}
	handle, err := windows.CreateFile(path, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return row
	}
	defer windows.CloseHandle(handle)
	var performance nativeDiskPerformance
	var count uint32
	const ioctlDiskPerformance = 0x70020
	err = windows.DeviceIoControl(handle, ioctlDiskPerformance, nil, 0, (*byte)(unsafe.Pointer(&performance)), uint32(unsafe.Sizeof(performance)), &count, nil)
	row.SampledAt = time.Now()
	if err == nil && count >= uint32(unsafe.Sizeof(performance)) && performance.BytesRead >= 0 && performance.BytesWritten >= 0 {
		row.ReadBytes = uint64(performance.BytesRead)
		row.WriteBytes = uint64(performance.BytesWritten)
		row.IOAvailable = true
		if performance.IdleTime >= 0 && performance.QueryTime > 0 {
			idle, query := uint64(performance.IdleTime), uint64(performance.QueryTime)
			row.Idle100ns = &idle
			row.Query100ns = &query
		}
	}
	// DiskSize is the physical device's capacity. Filesystem used space/mount
	// are intentionally absent because a disk can contain multiple volumes.
	const ioctlDiskGetDriveGeometryEx = 0x700a0
	geometry := make([]byte, 256)
	if err = windows.DeviceIoControl(handle, ioctlDiskGetDriveGeometryEx, nil, 0, &geometry[0], uint32(len(geometry)), &count, nil); err == nil && count >= 32 {
		total := binary.LittleEndian.Uint64(geometry[24:32])
		if total <= maxSafeNumber {
			row.TotalBytes = &total
		}
	}
	return row
}
func gatherDiskCounters(ctx context.Context) ([]diskCounter, []string) {
	result := []diskCounter{}
	unavailable := []string{}
	names, err := windowsPhysicalDrives()
	if err != nil {
		return result, []string{"disks"}
	}
	if len(names) > maxDisks {
		names = names[:maxDisks]
		unavailable = append(unavailable, "disks:truncated")
	}
	for _, name := range names {
		if ctx.Err() != nil {
			unavailable = append(unavailable, "disks:partial")
			break
		}
		result = append(result, windowsDiskCounter(name))
	}
	return result, unavailable
}
