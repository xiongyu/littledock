package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Apple's ioreg -a emits XML and adds exact IORegistryEntryID identities:
// https://github.com/apple-oss-distributions/IOKitTools/blob/main/ioreg.tproj/ioreg.c
// Driver-key evidence (not imported code):
// https://github.com/exelban/stats/blob/master/Modules/GPU/reader.swift
// https://gist.github.com/chockenberry/2afe4d0f1f9caddc81de
// VRAM capacity properties/types (independent implementation):
// https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/host/libhost.m
// Autodesk Maya SDK gpuCacheVramQuery.cpp also documents the PCI-parent keys:
// https://help.autodesk.com/cloudhelp/2027/ENU/MAYA-API-REF/cpp_ref/gpu_cache_2gpu_cache_vram_query_8cpp-example.html
const maxIORegGPUBytes = 1024 * 1024
const maxIORegScalarBytes = 64 * 1024
const maxIORegValues = 32768
const maxIORegDepth = 32

type ioregValue struct {
	kind  string
	text  string
	data  []byte
	array []ioregValue
	dict  map[string]ioregValue
}
type ioregPlistDecoder struct {
	xml    *xml.Decoder
	values int
}

func (d *ioregPlistDecoder) next() (xml.Token, error) {
	for {
		token, err := d.xml.Token()
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.Comment, xml.ProcInst:
			continue
		case xml.Directive:
			// encoding/xml never resolves external entities. Reject internal
			// entity declarations instead of accepting expanded arbitrary data.
			text := strings.TrimSpace(string(value))
			if !strings.HasPrefix(text, "DOCTYPE plist ") || strings.ContainsAny(text, "[]") {
				return nil, errors.New("unsupported XML declaration")
			}
			continue
		case xml.CharData:
			if strings.TrimSpace(string(value)) == "" {
				continue
			}
		}
		return token, nil
	}
}
func (d *ioregPlistDecoder) scalar(start xml.StartElement) (string, error) {
	var text strings.Builder
	for {
		token, err := d.xml.Token()
		if err != nil {
			return "", err
		}
		switch value := token.(type) {
		case xml.CharData:
			if text.Len()+len(value) > maxIORegScalarBytes {
				return "", errors.New("scalar limit")
			}
			text.Write(value)
		case xml.EndElement:
			if value.Name != start.Name {
				return "", errors.New("mismatched scalar")
			}
			return text.String(), nil
		default:
			return "", errors.New("nested scalar")
		}
	}
}
func (d *ioregPlistDecoder) value(start xml.StartElement, depth int) (ioregValue, error) {
	if depth > maxIORegDepth || d.values >= maxIORegValues || start.Name.Space != "" {
		return ioregValue{}, errors.New("plist limit")
	}
	d.values++
	result := ioregValue{kind: start.Name.Local}
	switch result.kind {
	case "dict":
		result.dict = make(map[string]ioregValue)
		for {
			token, err := d.next()
			if err != nil {
				return result, err
			}
			if end, ok := token.(xml.EndElement); ok && end.Name == start.Name {
				return result, nil
			}
			key, ok := token.(xml.StartElement)
			if !ok || key.Name.Local != "key" || key.Name.Space != "" {
				return result, errors.New("dictionary key expected")
			}
			name, err := d.scalar(key)
			if err != nil || len(name) > 1024 {
				return result, errors.New("invalid key")
			}
			if _, exists := result.dict[name]; exists {
				return result, errors.New("duplicate dictionary key")
			}
			token, err = d.next()
			if err != nil {
				return result, err
			}
			child, ok := token.(xml.StartElement)
			if !ok {
				return result, errors.New("dictionary value expected")
			}
			entry, err := d.value(child, depth+1)
			if err != nil {
				return result, err
			}
			result.dict[name] = entry
		}
	case "array":
		result.array = []ioregValue{}
		for {
			token, err := d.next()
			if err != nil {
				return result, err
			}
			if end, ok := token.(xml.EndElement); ok && end.Name == start.Name {
				return result, nil
			}
			child, ok := token.(xml.StartElement)
			if !ok {
				return result, errors.New("array value expected")
			}
			entry, err := d.value(child, depth+1)
			if err != nil {
				return result, err
			}
			result.array = append(result.array, entry)
		}
	case "string", "integer", "real", "data", "true", "false", "date":
		text, err := d.scalar(start)
		if err != nil {
			return result, err
		}
		result.text = text
		if result.kind == "data" {
			encoded := strings.Map(func(character rune) rune {
				if character == ' ' || character == '\t' || character == '\n' || character == '\r' {
					return -1
				}
				return character
			}, text)
			result.data, err = base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return result, err
			}
			result.text = ""
		}
		if (result.kind == "true" || result.kind == "false") && strings.TrimSpace(text) != "" {
			return result, errors.New("boolean payload")
		}
		return result, nil
	default:
		return result, errors.New("unsupported property type")
	}
}
func decodeIORegPlist(data []byte) (ioregValue, error) {
	if len(data) == 0 || len(data) > maxIORegGPUBytes {
		return ioregValue{}, errors.New("plist byte limit")
	}
	d := ioregPlistDecoder{xml: xml.NewDecoder(bytes.NewReader(data))}
	token, err := d.next()
	if err != nil {
		return ioregValue{}, err
	}
	plist, ok := token.(xml.StartElement)
	if !ok || plist.Name.Local != "plist" || plist.Name.Space != "" {
		return ioregValue{}, errors.New("plist root expected")
	}
	token, err = d.next()
	if err != nil {
		return ioregValue{}, err
	}
	root, ok := token.(xml.StartElement)
	if !ok {
		return ioregValue{}, errors.New("plist body expected")
	}
	result, err := d.value(root, 0)
	if err != nil {
		return result, err
	}
	token, err = d.next()
	if err != nil {
		return result, err
	}
	end, ok := token.(xml.EndElement)
	if !ok || end.Name != plist.Name {
		return result, errors.New("plist end expected")
	}
	if _, err = d.next(); err != io.EOF {
		return result, errors.New("trailing plist content")
	}
	if result.kind != "array" && result.kind != "dict" {
		return result, errors.New("registry tree expected")
	}
	return result, nil
}

func ioregString(value ioregValue) string {
	if value.kind == "string" {
		return strings.TrimSpace(value.text)
	}
	if value.kind == "data" && utf8.Valid(value.data) {
		text := strings.TrimRight(string(value.data), "\x00")
		if !strings.ContainsRune(text, 0) {
			return strings.TrimSpace(text)
		}
	}
	return ""
}
func ioregInteger(value ioregValue) (uint64, bool) {
	if value.kind != "integer" {
		return 0, false
	}
	text := strings.TrimSpace(value.text)
	base := 10
	if strings.HasPrefix(text, "0x") {
		base = 0
	}
	number, err := strconv.ParseUint(text, base, 64)
	return number, err == nil
}
func ioregPCIInteger(value ioregValue) (uint64, bool) {
	if value.kind == "data" && len(value.data) == 4 {
		return uint64(binary.LittleEndian.Uint32(value.data)), true
	}
	return ioregInteger(value)
}
func ioregNumber(value ioregValue, min, max float64) *float64 {
	if value.kind != "integer" && value.kind != "real" {
		return nil
	}
	return gpuNumber(value.text, min, max)
}
func ioregBytes(value ioregValue, unit uint64) *uint64 {
	if value.kind != "integer" {
		return nil
	}
	number, valid := ioregInteger(value)
	if !valid || number > uint64(maxSafeNumber)/unit {
		return nil
	}
	number *= unit
	return &number
}
func ioregClass(node map[string]ioregValue) string {
	class := ioregString(node["IOClass"])
	if class == "" {
		class = ioregString(node["IOObjectClass"])
	}
	return class
}
func ioregEntryID(node map[string]ioregValue) (uint64, bool) {
	id, valid := ioregInteger(node["IORegistryEntryID"])
	return id, valid && id != 0
}

// Children are arrays normally, single dictionaries in ioreg -t ancestor chains.
func walkIORegTree(value ioregValue, parentPCI uint64, visit func(map[string]ioregValue, uint64)) {
	if value.kind == "array" {
		for _, child := range value.array {
			walkIORegTree(child, parentPCI, visit)
		}
		return
	}
	if value.kind != "dict" {
		return
	}
	node := value.dict
	visit(node, parentPCI)
	if ioregClass(node) == "IOPCIDevice" {
		if id, ok := ioregEntryID(node); ok {
			parentPCI = id
		}
	}
	if children, exists := node["IORegistryEntryChildren"]; exists {
		walkIORegTree(children, parentPCI, visit)
	}
}

type ioregPCIDevice struct {
	name     string
	vendor   uint64
	vramSize *uint64
}

// Only the two documented VRAM-capacity keys accept binary integers. Intel
// Macs and the supported Darwin architectures are little endian. Do not apply
// this conversion to arbitrary CFData properties or performance counters.
func ioregVRAMCapacity(node map[string]ioregValue) *uint64 {
	for _, property := range []struct {
		key  string
		unit uint64
	}{{"VRAM,totalsize", 1}, {"VRAM,totalMB", 1024 * 1024}} {
		value, exists := node[property.key]
		if !exists {
			continue
		}
		var number uint64
		var valid bool
		if value.kind == "data" {
			switch len(value.data) {
			case 4:
				number, valid = uint64(binary.LittleEndian.Uint32(value.data)), true
			case 8:
				number, valid = binary.LittleEndian.Uint64(value.data), true
			}
		} else {
			number, valid = ioregInteger(value)
		}
		if valid && number > 0 && number <= uint64(maxSafeNumber)/property.unit {
			number *= property.unit
			return &number
		}
	}
	return nil
}

func parseIORegPCIInventory(data []byte) (map[uint64]ioregPCIDevice, []string) {
	devices := make(map[uint64]ioregPCIDevice)
	root, err := decodeIORegPlist(data)
	if err != nil {
		return devices, []string{"gpu:ioreg-inventory-unavailable"}
	}
	duplicates := make(map[uint64]bool)
	invalid := false
	walkIORegTree(root, 0, func(node map[string]ioregValue, _ uint64) {
		id, valid := ioregEntryID(node)
		if !valid {
			return
		}
		if _, exists := devices[id]; exists || duplicates[id] {
			delete(devices, id)
			duplicates[id] = true
			invalid = true
			return
		}
		vendor, ok := ioregPCIInteger(node["vendor-id"])
		if !ok {
			return
		}
		if len(devices) >= 256 {
			invalid = true
			return
		}
		devices[id] = ioregPCIDevice{name: boundedText(ioregString(node["model"]), 256), vendor: vendor, vramSize: ioregVRAMCapacity(node)}
	})
	if invalid {
		return devices, []string{"gpu:ioreg-inventory-unavailable"}
	}
	return devices, []string{}
}
func ioregVendor(node map[string]ioregValue, parent ioregPCIDevice) string {
	vendor, ok := ioregPCIInteger(node["vendor-id"])
	if !ok {
		vendor = parent.vendor
	}
	switch vendor {
	case 0x8086:
		return "Intel"
	case 0x1002:
		return "AMD"
	case 0x10de:
		return "NVIDIA"
	}
	if vendor != 0 {
		return ""
	}
	class := strings.ToLower(ioregClass(node) + " " + ioregString(node["CFBundleIdentifier"]))
	switch {
	case strings.Contains(class, "intel"):
		return "Intel"
	case strings.Contains(class, "amd") || strings.Contains(class, "ati"):
		return "AMD"
	case strings.Contains(class, "nvidia") || strings.Contains(class, "geforce") || strings.Contains(class, "nvaccelerator"):
		return "NVIDIA"
	}
	return ""
}
func ioregUtilization(stats map[string]ioregValue, vendor string) *float64 {
	for _, key := range []string{"Device Utilization %", "GPU Activity(%)"} {
		if value, exists := stats[key]; exists {
			return ioregNumber(value, 0, 100)
		}
	}
	// Legacy NVIDIA's named fixed-point counter: 1e9 represents 100%.
	// Do not infer the scale from whether a particular sample exceeds 100.
	if vendor == "NVIDIA" {
		if value, exists := stats["GPU Core Utilization"]; exists {
			raw := ioregNumber(value, 0, 1000000000)
			if raw != nil {
				percent := *raw / 10000000
				return &percent
			}
		}
	}
	return nil
}
func parseIORegGPU(data []byte, inventory map[uint64]ioregPCIDevice, sampledAt int64) ([]gpuDTO, []string) {
	devices := []gpuDTO{}
	unavailable := []string{}
	if len(data) > maxIORegGPUBytes {
		return devices, []string{"gpu:ioreg-output-limit"}
	}
	root, err := decodeIORegPlist(data)
	if err != nil {
		return devices, []string{"gpu:ioreg-invalid-output"}
	}
	seen := make(map[uint64]bool)
	walkIORegTree(root, 0, func(node map[string]ioregValue, parentID uint64) {
		statsValue, hasStats := node["PerformanceStatistics"]
		_, hasRevision := node["IOAccelRevision"]
		if !hasStats && !hasRevision && ioregString(node["IOMatchCategory"]) != "IOAccelerator" {
			return
		}
		parent := inventory[parentID]
		vendor := ioregVendor(node, parent)
		if vendor == "" {
			return
		}
		id, valid := ioregEntryID(node)
		if !valid {
			unavailable = append(unavailable, "gpu:ioreg-invalid-identity")
			return
		}
		if seen[id] {
			unavailable = append(unavailable, "gpu:ioreg-duplicate-identity")
			return
		}
		seen[id] = true
		if len(devices) >= maxGPUs {
			unavailable = append(unavailable, "gpu:truncated")
			return
		}
		name := ioregString(node["model"])
		if name == "" {
			name = parent.name
		}
		if name == "" {
			name = vendor + " / " + ioregString(node["IORegistryEntryName"])
		}
		device := gpuDTO{ID: fmt.Sprintf("ioreg:%016x", id), Name: boundedText(name, 256), Source: "macos-ioreg", SampledAt: &sampledAt, UtilizationScope: "device"}
		stats := statsValue.dict
		if statsValue.kind != "dict" {
			unavailable = append(unavailable, "gpu:ioreg-statistics-unavailable")
		}
		device.UtilizationPercent = ioregUtilization(stats, vendor)
		device.TemperatureCelsius = ioregNumber(stats["Temperature(C)"], -100, 250)
		device.SharedMemoryUsedBytes = ioregBytes(stats["inUseSysMemoryBytes"], 1)
		class := strings.ToLower(ioregClass(node) + " " + ioregString(node["CFBundleIdentifier"]))
		// Apple's Intel graphics drivers use system RAM; VRAM,totalMB often
		// describes a reservation/aperture, not dedicated or shared capacity.
		integrated := vendor == "Intel" && (strings.Contains(class, "appleintel") || strings.Contains(class, "intelaccelerator") || strings.Contains(strings.ToLower(name), "iris") || strings.Contains(strings.ToLower(name), "hd graphics") || strings.Contains(strings.ToLower(name), "uhd graphics"))
		if !integrated {
			device.MemoryUsedBytes = ioregBytes(stats["vramUsedBytes"], 1)
			device.MemoryTotalBytes = ioregVRAMCapacity(node)
			if device.MemoryTotalBytes == nil {
				device.MemoryTotalBytes = parent.vramSize
			}
			if device.MemoryUsedBytes != nil && device.MemoryTotalBytes != nil && *device.MemoryUsedBytes > *device.MemoryTotalBytes {
				device.MemoryUsedBytes = nil
				unavailable = append(unavailable, "gpu:ioreg-memory-invalid")
			}
			if device.MemoryUsedBytes == nil {
				unavailable = append(unavailable, "gpu:memory-used-unavailable")
			}
			if device.MemoryTotalBytes == nil {
				unavailable = append(unavailable, "gpu:memory-total-unavailable")
			}
		} else if device.SharedMemoryUsedBytes == nil {
			unavailable = append(unavailable, "gpu:shared-memory-unavailable")
		}
		if device.UtilizationPercent == nil {
			unavailable = append(unavailable, "gpu:utilization-unavailable")
		}
		devices = append(devices, device)
	})
	if len(devices) == 0 {
		unavailable = append(unavailable, "gpu:ioreg-no-supported-driver")
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	return devices, boundedUnavailable(unavailable)
}
