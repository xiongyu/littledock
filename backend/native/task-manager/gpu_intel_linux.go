package main

import (
	"context"
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

type intelI915QueryItem struct {
	ID     uint64
	Length int32
	Flags  uint32
	Data   uint64
}
type intelI915Query struct {
	Count, Flags uint32
	Items        uint64
}
type intelXeQuery struct {
	Extensions  uint64
	Query, Size uint32
	Data        uint64
	Reserved    [2]uint64
}

func intelIoctl(fd int, code uintptr, query unsafe.Pointer) error {
	_, _, err := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), code, uintptr(query))
	if err != 0 {
		return err
	}
	return nil
}
func intelMemoryBlob(ctx context.Context, fd int, driver string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if driver == "i915" {
		item := intelI915QueryItem{ID: 4}
		var pins runtime.Pinner
		pins.Pin(&item)
		defer pins.Unpin()
		query := intelI915Query{Count: 1, Items: uint64(uintptr(unsafe.Pointer(&item)))}
		// DRM_IOWR(DRM_COMMAND_BASE+DRM_I915_QUERY, drm_i915_query).
		if err := intelIoctl(fd, 0xc0106479, unsafe.Pointer(&query)); err != nil {
			return nil, err
		}
		runtime.KeepAlive(&item)
		if item.Length <= 0 || item.Length > 65536 {
			return nil, errors.New("invalid i915 memory query size")
		}
		buffer := make([]byte, item.Length)
		pins.Pin(&buffer[0])
		item.Data = uint64(uintptr(unsafe.Pointer(&buffer[0])))
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		err := intelIoctl(fd, 0xc0106479, unsafe.Pointer(&query))
		runtime.KeepAlive(&item)
		runtime.KeepAlive(buffer)
		if err != nil || item.Length <= 0 || int(item.Length) > len(buffer) {
			return nil, errors.New("i915 memory query unavailable")
		}
		return buffer[:item.Length], nil
	}
	if driver == "xe" {
		query := intelXeQuery{Query: 1}
		// DRM_IOWR(DRM_COMMAND_BASE+DRM_XE_DEVICE_QUERY, drm_xe_device_query).
		if err := intelIoctl(fd, 0xc0286440, unsafe.Pointer(&query)); err != nil {
			return nil, err
		}
		if query.Size == 0 || query.Size > 65536 {
			return nil, errors.New("invalid xe memory query size")
		}
		buffer := make([]byte, query.Size)
		var pins runtime.Pinner
		pins.Pin(&buffer[0])
		defer pins.Unpin()
		query.Data = uint64(uintptr(unsafe.Pointer(&buffer[0])))
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		err := intelIoctl(fd, 0xc0286440, unsafe.Pointer(&query))
		runtime.KeepAlive(buffer)
		if err != nil || query.Size == 0 || int(query.Size) > len(buffer) {
			return nil, errors.New("xe memory query unavailable")
		}
		return buffer[:query.Size], nil
	}
	return nil, errors.New("unsupported Intel driver")
}

func intelCanReadDeviceUsage(procRoot string) bool {
	// A capability inside a nested user namespace does not imply perfmon_capable
	// for the GPU driver. Require the initial UID mapping as well as CapEff.
	mapping, err := readIntelBounded(procRoot+"/self/uid_map", 4096)
	if err != nil {
		return false
	}
	fields := strings.Fields(string(mapping))
	if len(fields) != 3 || fields[0] != "0" || fields[1] != "0" || fields[2] != "4294967295" {
		return false
	}
	status, err := readIntelBounded(procRoot+"/self/status", 16384)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(status), "\n") {
		if value, ok := strings.CutPrefix(line, "CapEff:"); ok {
			caps, err := strconv.ParseUint(strings.TrimSpace(value), 16, 64)
			return err == nil && (caps&(uint64(1)<<38|uint64(1)<<21)) != 0
		}
	}
	return false
}
func readIntelMemory(ctx context.Context, node, driver string) (intelMemoryInfo, []string) {
	if node == "" {
		return intelMemoryInfo{}, []string{"gpu:intel-render-node-unavailable"}
	}
	stat, err := os.Stat(node)
	if err != nil || stat.Mode()&os.ModeCharDevice == 0 {
		return intelMemoryInfo{}, []string{"gpu:intel-render-node-unavailable"}
	}
	fd, err := unix.Open(node, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return intelMemoryInfo{}, []string{"gpu:intel-memory-permission-denied"}
		}
		return intelMemoryInfo{}, []string{"gpu:intel-memory-query-unavailable"}
	}
	defer unix.Close(fd)
	data, err := intelMemoryBlob(ctx, fd, driver)
	if err != nil {
		return intelMemoryInfo{}, []string{"gpu:intel-memory-query-unavailable"}
	}
	canRead := driver == "xe" || intelCanReadDeviceUsage("/proc")
	memory, err := parseIntelMemoryRegions(driver, data, canRead)
	if err != nil {
		return intelMemoryInfo{}, []string{"gpu:intel-memory-query-unavailable"}
	}
	if !canRead {
		return memory, []string{"gpu:intel-memory-permission-denied"}
	}
	return memory, nil
}
