package main

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var gpuPDH = windows.NewLazySystemDLL("pdh.dll")
var gpuOpenQuery = gpuPDH.NewProc("PdhOpenQueryW")
var gpuAddCounter = gpuPDH.NewProc("PdhAddEnglishCounterW")
var gpuCollect = gpuPDH.NewProc("PdhCollectQueryData")
var gpuReadArray = gpuPDH.NewProc("PdhGetFormattedCounterArrayW")
var gpuCloseQuery = gpuPDH.NewProc("PdhCloseQuery")
var gpuFactory = windows.NewLazySystemDLL("dxgi.dll").NewProc("CreateDXGIFactory1")

const gpuPDHMoreData = 0x800007d2
const gpuPDHDouble = 0x00000200
const gpuPDHNoCap100 = 0x00008000

type gpuPdhValue struct {
	Status uint32
	_      uint32
	Value  float64
}
type gpuPdhItem struct {
	Name  *uint16
	Value gpuPdhValue
}
type gpuCounterValue struct {
	name  string
	value float64
}
type gpuDXGIDesc struct {
	Description                                                     [128]uint16
	VendorID, DeviceID, SubSysID, Revision                          uint32
	DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory uintptr
	LuidLow                                                         uint32
	LuidHigh                                                        int32
	Flags                                                           uint32
}
type gpuAdapter struct {
	luid, name   string
	memory       *uint64
	sharedMemory *uint64
}
type gpuWindowsState struct {
	query, engine, memory, sharedMemory uintptr
	primed                              bool
	attempted                           time.Time
	adapters                            []gpuAdapter
	refreshed                           time.Time
	unavailable                         []string
}

var windowsGPU gpuWindowsState

// DedicatedSystemMemory is reserved for GPU-exclusive use at boot, unlike
// SharedSystemMemory. Some integrated drivers report the reservation here.
func gpuDedicatedCapacity(description gpuDXGIDesc) *uint64 {
	video, system := uint64(description.DedicatedVideoMemory), uint64(description.DedicatedSystemMemory)
	if video > maxSafeNumber || system > maxSafeNumber-video {
		return nil
	}
	value := video + system
	return &value
}

func gpuCOMMethod(object uintptr, index int) uintptr {
	vtable := *(*uintptr)(unsafe.Pointer(object))
	return *(*uintptr)(unsafe.Pointer(vtable + uintptr(index)*unsafe.Sizeof(uintptr(0))))
}
func gpuCOMRelease(object uintptr) {
	if object != 0 {
		syscall.SyscallN(gpuCOMMethod(object, 2), object)
	}
}

// DXGI's AdapterLuid is the key reported by WDDM performance instances. Never
// pair counters with cards by enumeration index or by similar product names.
func enumerateGPUAdapters() ([]gpuAdapter, []string) {
	if gpuFactory.Find() != nil {
		return nil, []string{"gpu:dxgi-unavailable"}
	}
	iid := windows.GUID{Data1: 0x770aae78, Data2: 0xf26f, Data3: 0x4dba, Data4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87}}
	var factory uintptr
	hr, _, _ := gpuFactory.Call(uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&factory)))
	if uint32(hr) != 0 || factory == 0 {
		return nil, []string{"gpu:dxgi-unavailable"}
	}
	defer gpuCOMRelease(factory)
	adapters := []gpuAdapter{}
	unavailable := []string{}
	for index := 0; index <= maxGPUs; index++ {
		var adapter uintptr
		hr, _, _ = syscall.SyscallN(gpuCOMMethod(factory, 12), factory, uintptr(index), uintptr(unsafe.Pointer(&adapter)))
		if uint32(hr) == 0x887a0002 {
			break
		}
		if uint32(hr) != 0 || adapter == 0 {
			unavailable = append(unavailable, "gpu:adapter-enumeration-failed")
			break
		}
		var description gpuDXGIDesc
		hr, _, _ = syscall.SyscallN(gpuCOMMethod(adapter, 10), adapter, uintptr(unsafe.Pointer(&description)))
		gpuCOMRelease(adapter)
		if uint32(hr) != 0 {
			unavailable = append(unavailable, "gpu:adapter-description-unavailable")
			continue
		}
		if description.Flags&3 != 0 {
			continue
		} // DXGI_ADAPTER_FLAG_REMOTE | DXGI_ADAPTER_FLAG_SOFTWARE
		if len(adapters) >= maxGPUs {
			unavailable = append(unavailable, "gpu:truncated")
			break
		}
		memory := gpuDedicatedCapacity(description)
		var sharedMemory *uint64
		if uint64(description.SharedSystemMemory) < uint64(1)<<53 {
			value := uint64(description.SharedSystemMemory)
			sharedMemory = &value
		}
		luid := fmt.Sprintf("%08x:%08x", uint32(description.LuidHigh), description.LuidLow)
		name := boundedText(windows.UTF16ToString(description.Description[:]), 256)
		if name == "" {
			name = "Windows GPU " + luid
		}
		adapters = append(adapters, gpuAdapter{luid, name, memory, sharedMemory})
	}
	return adapters, unavailable
}

func openGPUQuery() []string {
	for _, procedure := range []*windows.LazyProc{gpuOpenQuery, gpuAddCounter, gpuCollect, gpuReadArray, gpuCloseQuery} {
		if procedure.Find() != nil {
			return []string{"gpu:pdh-unavailable"}
		}
	}
	status, _, _ := gpuOpenQuery.Call(0, 0, uintptr(unsafe.Pointer(&windowsGPU.query)))
	if uint32(status) != 0 {
		windowsGPU.query = 0
		return []string{"gpu:pdh-unavailable"}
	}
	add := func(path string, destination *uintptr) bool {
		text, _ := windows.UTF16PtrFromString(path)
		status, _, _ := gpuAddCounter.Call(windowsGPU.query, uintptr(unsafe.Pointer(text)), 0, uintptr(unsafe.Pointer(destination)))
		return uint32(status) == 0
	}
	unavailable := []string{}
	if !add(`\GPU Engine(*)\Utilization Percentage`, &windowsGPU.engine) {
		unavailable = append(unavailable, "gpu:utilization-unavailable")
	}
	if !add(`\GPU Adapter Memory(*)\Dedicated Usage`, &windowsGPU.memory) {
		unavailable = append(unavailable, "gpu:memory-used-unavailable")
	}
	if !add(`\GPU Adapter Memory(*)\Shared Usage`, &windowsGPU.sharedMemory) {
		unavailable = append(unavailable, "gpu:shared-memory-unavailable")
	}
	return unavailable
}

func readGPUArray(counter uintptr) ([]gpuCounterValue, bool) {
	if counter == 0 {
		return nil, false
	}
	var size, count uint32
	status, _, _ := gpuReadArray.Call(counter, gpuPDHDouble|gpuPDHNoCap100, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), 0)
	if uint32(status) != gpuPDHMoreData || size == 0 || size > 2*1024*1024 || count > 8192 {
		return nil, false
	}
	buffer := make([]byte, size)
	status, _, _ = gpuReadArray.Call(counter, gpuPDHDouble|gpuPDHNoCap100, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&buffer[0])))
	if uint32(status) != 0 || count > 8192 || uint64(count)*uint64(unsafe.Sizeof(gpuPdhItem{})) > uint64(len(buffer)) {
		return nil, false
	}
	items := unsafe.Slice((*gpuPdhItem)(unsafe.Pointer(&buffer[0])), int(count))
	values := make([]gpuCounterValue, 0, count)
	base := uintptr(unsafe.Pointer(&buffer[0]))
	end := base + uintptr(len(buffer))
	for _, item := range items {
		if item.Value.Status > 1 || math.IsNaN(item.Value.Value) || math.IsInf(item.Value.Value, 0) || item.Value.Value < 0 {
			continue
		}
		address := uintptr(unsafe.Pointer(item.Name))
		if address < base || address >= end || address%2 != 0 {
			continue
		}
		length := min(int((end-address)/2), 512)
		name := windows.UTF16ToString(unsafe.Slice(item.Name, length))
		if len(name) > 512 {
			continue
		}
		values = append(values, gpuCounterValue{name, item.Value.Value})
	}
	return values, true
}

var gpuInstance = regexp.MustCompile(`(?:^|_)luid_0x([0-9a-fA-F]{1,8})_0x([0-9a-fA-F]{1,8})_phys_([0-9]{1,5})(?:_|$)`)
var gpuEngineInstance = regexp.MustCompile(`_eng_([0-9]{1,5})(?:_|$)`)

func gpuInstanceIdentity(name string) (luid, physical string, valid bool) {
	match := gpuInstance.FindStringSubmatch(name)
	if match == nil {
		return "", "", false
	}
	high, errHigh := strconv.ParseUint(match[1], 16, 32)
	low, errLow := strconv.ParseUint(match[2], 16, 32)
	index, errIndex := strconv.ParseUint(match[3], 10, 16)
	if errHigh != nil || errLow != nil || errIndex != nil {
		return "", "", false
	}
	return fmt.Sprintf("%08x:%08x", high, low), strconv.FormatUint(index, 10), true
}

func combineGPUCounters(adapters []gpuAdapter, engine, memory, sharedMemory []gpuCounterValue, primed bool, sampledAt int64) ([]gpuDTO, []string) {
	known := make(map[string]gpuAdapter)
	identities := make(map[string]map[string]bool)
	unavailable := []string{}
	for _, adapter := range adapters {
		known[adapter.luid] = adapter
		identities[adapter.luid] = map[string]bool{"0": true}
	}
	busy := make(map[string]map[string]float64)
	used := make(map[string]float64)
	sharedUsed := make(map[string]float64)
	for _, counter := range engine {
		luid, physical, valid := gpuInstanceIdentity(counter.name)
		match := gpuEngineInstance.FindStringSubmatch(counter.name)
		if !valid || match == nil {
			continue
		}
		if _, found := known[luid]; !found {
			continue
		}
		identities[luid][physical] = true
		id := luid + ":" + physical
		if busy[id] == nil {
			busy[id] = make(map[string]float64)
		}
		busy[id][match[1]] += counter.value
	}
	for _, counter := range memory {
		luid, physical, valid := gpuInstanceIdentity(counter.name)
		if !valid {
			continue
		}
		if _, found := known[luid]; !found {
			continue
		}
		identities[luid][physical] = true
		used[luid+":"+physical] = counter.value
	}
	for _, counter := range sharedMemory {
		luid, physical, valid := gpuInstanceIdentity(counter.name)
		if !valid {
			continue
		}
		if _, found := known[luid]; !found {
			continue
		}
		identities[luid][physical] = true
		sharedUsed[luid+":"+physical] = counter.value
	}
	devices := []gpuDTO{}
	for _, adapter := range adapters {
		// Keep deterministic identities in returned samples, independently of PDH's order.
		physicalIDs := make([]int, 0, len(identities[adapter.luid]))
		for part := range identities[adapter.luid] {
			number, _ := strconv.Atoi(part)
			physicalIDs = append(physicalIDs, number)
		}
		sort.Ints(physicalIDs)
		for _, physical := range physicalIDs {
			part := strconv.Itoa(physical)
			if len(devices) == maxGPUs {
				return devices, append(unavailable, "gpu:truncated")
			}
			id := adapter.luid + ":" + part
			device := gpuDTO{ID: "luid:" + id, Name: adapter.name, Source: "windows-pdh-dxgi", SampledAt: &sampledAt, UtilizationScope: "device"}
			if len(identities[adapter.luid]) == 1 {
				device.MemoryTotalBytes = adapter.memory
				device.SharedMemoryTotalBytes = adapter.sharedMemory
			} else {
				device.Name += " · node " + part
			}
			if value, found := used[id]; found && value >= 0 && value < float64(uint64(1)<<53) {
				amount := uint64(value)
				device.MemoryUsedBytes = &amount
			}
			if device.MemoryUsedBytes != nil && device.MemoryTotalBytes != nil && *device.MemoryUsedBytes > *device.MemoryTotalBytes {
				device.MemoryUsedBytes = nil
			}
			if value, found := sharedUsed[id]; found && value >= 0 && value < float64(uint64(1)<<53) {
				amount := uint64(value)
				device.SharedMemoryUsedBytes = &amount
			}
			if device.SharedMemoryUsedBytes != nil && device.SharedMemoryTotalBytes != nil && *device.SharedMemoryUsedBytes > *device.SharedMemoryTotalBytes {
				device.SharedMemoryUsedBytes = nil
			}
			if device.SharedMemoryUsedBytes == nil {
				unavailable = append(unavailable, "gpu:shared-memory-unavailable")
			}
			if primed && len(busy[id]) > 0 {
				maximum := 0.0
				for _, value := range busy[id] {
					maximum = math.Max(maximum, value)
				}
				value := math.Min(maximum, 100)
				device.UtilizationPercent = &value
			}
			if device.MemoryTotalBytes == nil {
				unavailable = append(unavailable, "gpu:memory-total-unavailable")
			}
			if device.MemoryUsedBytes == nil {
				unavailable = append(unavailable, "gpu:memory-used-unavailable")
			}
			if device.UtilizationPercent == nil {
				if primed {
					unavailable = append(unavailable, "gpu:utilization-unavailable")
				} else {
					unavailable = append(unavailable, "gpu:utilization-warming-up")
				}
			}
			devices = append(devices, device)
		}
	}
	return devices, unavailable
}

func collectGPUPlatform(ctx context.Context) ([]gpuDTO, []string) {
	now := time.Now()
	if windowsGPU.refreshed.IsZero() || now.Sub(windowsGPU.refreshed) > 30*time.Second {
		windowsGPU.adapters, windowsGPU.unavailable = enumerateGPUAdapters()
		windowsGPU.refreshed = now
	}
	if ctx.Err() != nil {
		return []gpuDTO{}, []string{"gpu:timed-out"}
	}
	unavailable := append([]string{}, windowsGPU.unavailable...)
	if (windowsGPU.query == 0 || windowsGPU.engine == 0 || windowsGPU.memory == 0 || windowsGPU.sharedMemory == 0) && (windowsGPU.attempted.IsZero() || now.Sub(windowsGPU.attempted) > 30*time.Second) {
		// A driver can register its counters after the collector starts. Retry
		// missing registrations on a bounded cadence, releasing the old query.
		if windowsGPU.query != 0 {
			gpuCloseQuery.Call(windowsGPU.query)
		}
		windowsGPU.query, windowsGPU.engine, windowsGPU.memory, windowsGPU.sharedMemory = 0, 0, 0, 0
		windowsGPU.primed = false
		windowsGPU.attempted = now
		unavailable = append(unavailable, openGPUQuery()...)
	}
	var engines, memory, sharedMemory []gpuCounterValue
	primed := windowsGPU.primed
	if windowsGPU.query != 0 {
		status, _, _ := gpuCollect.Call(windowsGPU.query)
		if uint32(status) == 0 {
			engines, _ = readGPUArray(windowsGPU.engine)
			memory, _ = readGPUArray(windowsGPU.memory)
			sharedMemory, _ = readGPUArray(windowsGPU.sharedMemory)
			windowsGPU.primed = true
		} else {
			unavailable = append(unavailable, "gpu:driver-counters-unavailable")
			primed = false
			windowsGPU.primed = false
		}
	}
	devices, missing := combineGPUCounters(windowsGPU.adapters, engines, memory, sharedMemory, primed, time.Now().UnixMilli())
	unavailable = append(unavailable, missing...)
	compute, computeMissing := collectNvidiaComputeWindows(ctx)
	devices = append(devices, compute...)
	unavailable = append(unavailable, computeMissing...)
	if len(devices) == 0 {
		unavailable = append(unavailable, "gpu:no-supported-adapter")
	}
	return devices, unavailable
}
func closeGPUPlatform() {
	if windowsGPU.query != 0 {
		gpuCloseQuery.Call(windowsGPU.query)
	}
	windowsGPU = gpuWindowsState{}
}
