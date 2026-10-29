package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"
)

func macGPUPlist(body string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">` + body + `</plist>`)
}
func macGPUData(value string) string {
	return "<data>\n " + base64.StdEncoding.EncodeToString([]byte(value)) + "\n</data>"
}
func macGPUEntry(id, class, properties, statistics string) string {
	return `<dict><key>IORegistryEntryID</key><integer>` + id + `</integer><key>IOClass</key><string>` + class + `</string><key>IORegistryEntryName</key><string>` + class + `</string><key>IOMatchCategory</key><string>IOAccelerator</string>` + properties + `<key>PerformanceStatistics</key><dict>` + statistics + `</dict></dict>`
}
func macGPUHasCode(codes []string, expected string) bool {
	for _, code := range codes {
		if code == expected {
			return true
		}
	}
	return false
}
func macGPUMetric(t *testing.T, value *float64, expected float64) {
	t.Helper()
	if value == nil || *value != expected {
		t.Fatalf("expected %v, got %v", expected, value)
	}
}
func macGPUBytes(t *testing.T, value *uint64, expected uint64) {
	t.Helper()
	if value == nil || *value != expected {
		t.Fatalf("expected %d, got %v", expected, value)
	}
}

func TestMacGPUIntelAMDAndNvidiaDriverFields(t *testing.T) {
	intel := macGPUEntry("4294968001", "IntelAccelerator", `<key>model</key>`+macGPUData("Intel UHD Graphics 630\x00")+`<key>CFBundleIdentifier</key><string>com.apple.driver.AppleIntelKBLGraphics</string><key>VRAM,totalMB</key><integer>1536</integer>`, `<key>Device Utilization %</key><real>37.5</real><key>inUseSysMemoryBytes</key><integer>268435456</integer><key>gartSizeBytes</key><integer>17179869184</integer><key>gartUsedBytes</key><integer>9999999</integer>`)
	amd := macGPUEntry("4294968002", "AMDRadeonX4000_AMDGraphicsAccelerator", `<key>model</key>`+macGPUData("AMD Radeon RX 580\x00")+`<key>VRAM,totalMB</key><integer>8192</integer>`, `<key>GPU Activity(%)</key><integer>65</integer><key>vramUsedBytes</key><integer>1073741824</integer><key>Temperature(C)</key><real>55.5</real>`)
	nvidia := macGPUEntry("4294968003", "NVAccelerator", `<key>model</key><string>NVIDIA GeForce GTX 780</string><key>VRAM,totalMB</key><integer>2048</integer>`, `<key>GPU Core Utilization</key><integer>120000000</integer><key>vramUsedBytes</key><integer>536870912</integer><key>inUseSysMemoryBytes</key><integer>0</integer>`)
	// Explicit dedicated-memory metrics from an Intel discrete driver remain
	// supported; this is a synthetic parser fixture, not a macOS Arc validation.
	discrete := macGPUEntry("4294968004", "IntelDG2Accelerator", `<key>model</key><string>Intel Arc A770</string><key>VRAM,totalMB</key><integer>16384</integer>`, `<key>Device Utilization %</key><integer>49</integer><key>vramUsedBytes</key><integer>4294967296</integer>`)
	devices, codes := parseIORegGPU(macGPUPlist("<array>"+intel+amd+nvidia+discrete+"</array>"), nil, 123456)
	if len(devices) != 4 || len(codes) != 0 {
		t.Fatalf("unexpected devices/codes %+v %v", devices, codes)
	}
	macGPUMetric(t, devices[0].UtilizationPercent, 37.5)
	macGPUBytes(t, devices[0].SharedMemoryUsedBytes, 268435456)
	if devices[0].MemoryUsedBytes != nil || devices[0].MemoryTotalBytes != nil || devices[0].SharedMemoryTotalBytes != nil {
		t.Fatal("Intel RAM reservation or GART size masqueraded as VRAM/shared capacity")
	}
	macGPUMetric(t, devices[1].UtilizationPercent, 65)
	macGPUBytes(t, devices[1].MemoryTotalBytes, 8*1024*1024*1024)
	macGPUMetric(t, devices[1].TemperatureCelsius, 55.5)
	macGPUMetric(t, devices[2].UtilizationPercent, 12)
	macGPUBytes(t, devices[2].MemoryUsedBytes, 536870912)
	macGPUBytes(t, devices[2].SharedMemoryUsedBytes, 0)
	macGPUBytes(t, devices[3].MemoryTotalBytes, 16*1024*1024*1024)
	for _, device := range devices {
		if device.Source != "macos-ioreg" || device.UtilizationScope != "device" || device.SampledAt == nil || *device.SampledAt != 123456 {
			t.Fatalf("wrong source/timestamp/scope %+v", device)
		}
	}
	if devices[0].Name != "Intel UHD Graphics 630" || devices[1].Name != "AMD Radeon RX 580" {
		t.Fatal("binary hardware model properties not decoded")
	}
}

func TestMacGPUExactRegistryParentHardwareName(t *testing.T) {
	pci := func(id, name string) string {
		return `<dict><key>IORegistryEntryID</key><integer>` + id + `</integer><key>IOObjectClass</key><string>IOPCIDevice</string><key>vendor-id</key><data>AhAAAA==</data><key>model</key>` + macGPUData(name+"\x00") + `</dict>`
	}
	inventory, codes := parseIORegPCIInventory(macGPUPlist("<array>" + pci("6001", "AMD Radeon RX 580") + pci("6002", "AMD Radeon RX 6800") + "</array>"))
	if len(inventory) != 2 || len(codes) != 0 {
		t.Fatal("PCI inventory failed")
	}
	child := macGPUEntry("7001", "AMDRadeonAccelerator", "", `<key>GPU Activity(%)</key><integer>20</integer>`)
	parent := `<dict><key>IORegistryEntryID</key><integer>6002</integer><key>IOObjectClass</key><string>IOPCIDevice</string><key>IORegistryEntryChildren</key>` + child + `</dict>`
	devices, _ := parseIORegGPU(macGPUPlist("<array>"+parent+"</array>"), inventory, 1)
	if len(devices) != 1 || devices[0].Name != "AMD Radeon RX 6800" || devices[0].ID != "ioreg:0000000000001b59" {
		t.Fatalf("did not join exact ancestor identity: %+v", devices)
	}
	devices, _ = parseIORegGPU(macGPUPlist("<array>"+child+"</array>"), inventory, 1)
	if devices[0].Name == "AMD Radeon RX 580" || devices[0].Name == "AMD Radeon RX 6800" {
		t.Fatal("hardware names guessed without ancestor identity")
	}
	inventory, codes = parseIORegPCIInventory(macGPUPlist("<array>" + pci("6002", "First") + pci("6002", "Conflicting") + "</array>"))
	if len(inventory) != 0 || !macGPUHasCode(codes, "gpu:ioreg-inventory-unavailable") {
		t.Fatal("ambiguous PCI identity accepted")
	}
}

func TestMacGPUExactParentVRAMCapacityTypes(t *testing.T) {
	binaryData := func(number uint64, size int) string {
		data := make([]byte, 8)
		binary.LittleEndian.PutUint64(data, number)
		return macGPUData(string(data[:size]))
	}
	for _, sample := range []struct {
		key, value string
		expected   uint64
	}{
		{"VRAM,totalMB", "<integer>8192</integer>", 8 * 1024 * 1024 * 1024},
		{"VRAM,totalMB", binaryData(8192, 4), 8 * 1024 * 1024 * 1024},
		{"VRAM,totalMB", binaryData(8192, 8), 8 * 1024 * 1024 * 1024},
		{"VRAM,totalsize", "<integer>8589934592</integer>", 8 * 1024 * 1024 * 1024},
		{"VRAM,totalsize", binaryData(2147483648, 4), 2 * 1024 * 1024 * 1024},
		{"VRAM,totalsize", binaryData(8589934592, 8), 8 * 1024 * 1024 * 1024},
	} {
		property := "<key>" + sample.key + "</key>" + sample.value
		pci := `<dict><key>IORegistryEntryID</key><integer>6001</integer><key>IOObjectClass</key><string>IOPCIDevice</string><key>vendor-id</key><data>AhAAAA==</data>` + property + `</dict>`
		inventory, codes := parseIORegPCIInventory(macGPUPlist("<array>" + pci + "</array>"))
		if len(codes) != 0 {
			t.Fatal(codes)
		}
		child := macGPUEntry("7001", "AMDRadeonAccelerator", "", "")
		parent := `<dict><key>IORegistryEntryID</key><integer>6001</integer><key>IOObjectClass</key><string>IOPCIDevice</string><key>IORegistryEntryChildren</key>` + child + `</dict>`
		devices, _ := parseIORegGPU(macGPUPlist("<array>"+parent+"</array>"), inventory, 1)
		macGPUBytes(t, devices[0].MemoryTotalBytes, sample.expected)
		devices, _ = parseIORegGPU(macGPUPlist("<array>"+child+"</array>"), inventory, 1)
		if devices[0].MemoryTotalBytes != nil {
			t.Fatal("capacity guessed without exact parent identity")
		}
		devices, _ = parseIORegGPU(macGPUPlist("<array>"+macGPUEntry("7001", "NVAccelerator", property, "")+"</array>"), nil, 1)
		macGPUBytes(t, devices[0].MemoryTotalBytes, sample.expected)
	}
	for _, value := range []string{"<integer>0</integer>", "<integer>-1</integer>", "<real>8192</real>", "<string>8192</string>", binaryData(^uint64(0), 8), macGPUData("\x00\x20\x00"), macGPUData("\x00\x20\x00\x00\x00\x00\x00\x00\x00")} {
		devices, _ := parseIORegGPU(macGPUPlist("<array>"+macGPUEntry("1", "NVAccelerator", "<key>VRAM,totalMB</key>"+value, "")+"</array>"), nil, 1)
		if devices[0].MemoryTotalBytes != nil {
			t.Fatalf("invalid capacity accepted %s", value)
		}
	}
	intel := macGPUEntry("1", "IntelAccelerator", "<key>VRAM,totalMB</key>"+binaryData(1536, 4), `<key>vramUsedBytes</key>`+binaryData(256, 4)+`<key>Device Utilization %</key>`+binaryData(50, 4))
	devices, _ := parseIORegGPU(macGPUPlist("<array>"+intel+"</array>"), map[uint64]ioregPCIDevice{0: {vendor: 0x8086, vramSize: new(uint64)}}, 1)
	if devices[0].MemoryTotalBytes != nil || devices[0].MemoryUsedBytes != nil || devices[0].SharedMemoryTotalBytes != nil || devices[0].UtilizationPercent != nil {
		t.Fatal("Intel reservation or arbitrary binary counters accepted")
	}
}

func TestMacGPURegistryIDsAreExactUniqueAndBounded(t *testing.T) {
	large := macGPUEntry("18446744073709551614", "NVAccelerator", `<key>model</key><string>Identical model</string>`, "")
	other := macGPUEntry("18446744073709551613", "NVAccelerator", `<key>model</key><string>Identical model</string>`, "")
	devices, codes := parseIORegGPU(macGPUPlist("<array>"+large+other+large+"</array>"), nil, 1)
	if len(devices) != 2 || devices[0].ID != "ioreg:fffffffffffffffd" || devices[1].ID != "ioreg:fffffffffffffffe" || !macGPUHasCode(codes, "gpu:ioreg-duplicate-identity") {
		t.Fatal("registry IDs lost precision or were deduplicated by model")
	}
	for _, id := range []string{"0", "-1", "18446744073709551616", "NaN"} {
		devices, codes = parseIORegGPU(macGPUPlist("<array>"+macGPUEntry(id, "NVAccelerator", "", "")+"</array>"), nil, 1)
		if len(devices) != 0 || !macGPUHasCode(codes, "gpu:ioreg-invalid-identity") {
			t.Fatalf("invalid registry ID accepted %s", id)
		}
	}
	var many strings.Builder
	for index := 0; index < maxGPUs+10; index++ {
		many.WriteString(macGPUEntry(fmt.Sprint(index+1), "NVAccelerator", "", ""))
	}
	devices, codes = parseIORegGPU(macGPUPlist("<array>"+many.String()+"</array>"), nil, 1)
	if len(devices) != maxGPUs || len(codes) > 64 || !macGPUHasCode(codes, "gpu:truncated") {
		t.Fatal("device/reason limit not enforced")
	}
}

func TestMacGPUInvalidMetricsNeverBecomeZeroOrGuessedTotals(t *testing.T) {
	for _, value := range []string{"-1", "NaN", "Inf", "101"} {
		stats := `<key>Device Utilization %</key><real>` + value + `</real><key>vramUsedBytes</key><integer>18446744073709551615</integer><key>inUseSysMemoryBytes</key><integer>18446744073613955072</integer>`
		devices, codes := parseIORegGPU(macGPUPlist("<array>"+macGPUEntry("1", "NVAccelerator", "", stats)+"</array>"), nil, 1)
		if devices[0].UtilizationPercent != nil || devices[0].MemoryUsedBytes != nil || devices[0].SharedMemoryUsedBytes != nil || !macGPUHasCode(codes, "gpu:utilization-unavailable") {
			t.Fatalf("invalid values accepted %s", value)
		}
	}
	stats := `<key>GPU Core Utilization</key><integer>50</integer><key>vramUsedBytes</key><integer>512</integer><key>vramFreeBytes</key><integer>512</integer>`
	devices, _ := parseIORegGPU(macGPUPlist("<array>"+macGPUEntry("1", "NVAccelerator", "", stats)+"</array>"), nil, 1)
	macGPUMetric(t, devices[0].UtilizationPercent, 0.000005)
	if devices[0].MemoryTotalBytes != nil {
		t.Fatal("used+free was assumed to be physical capacity")
	}
	stats = `<key>GPU Activity(%)</key><string>45</string><key>vramUsedBytes</key><integer>2097152</integer>`
	devices, codes := parseIORegGPU(macGPUPlist("<array>"+macGPUEntry("1", "AMDRadeonAccelerator", `<key>VRAM,totalMB</key><integer>1</integer>`, stats)+"</array>"), nil, 1)
	if devices[0].MemoryUsedBytes != nil || devices[0].UtilizationPercent != nil || !macGPUHasCode(codes, "gpu:ioreg-memory-invalid") {
		t.Fatal("wrong property types or memory exceeding total accepted")
	}
	intel := macGPUEntry("2", "IntelAccelerator", `<key>VRAM,totalMB</key><integer>1536</integer>`, `<key>gartUsedBytes</key><integer>1048576</integer><key>gartSizeBytes</key><integer>1610612736</integer>`)
	devices, codes = parseIORegGPU(macGPUPlist("<array>"+intel+"</array>"), nil, 1)
	if devices[0].SharedMemoryUsedBytes != nil || devices[0].SharedMemoryTotalBytes != nil || !macGPUHasCode(codes, "gpu:shared-memory-unavailable") {
		t.Fatal("graphics address mappings masqueraded as physical shared memory")
	}
}

func TestMacGPUPlistDepthBytesTypesAndEntityBounds(t *testing.T) {
	invalid := [][]byte{
		[]byte("bplist00"), macGPUPlist(`<array><dict><key>duplicate</key><integer>1</integer><key>duplicate</key><integer>2</integer></dict></array>`),
		macGPUPlist(`<array><data>not_base64!</data></array>`), macGPUPlist(`<array><dict><key>key</key></dict></array>`),
		macGPUPlist(`<array><integer><string>1</string></integer></array>`), macGPUPlist(`<array>` + strings.Repeat(`<array>`, maxIORegDepth+2) + strings.Repeat(`</array>`, maxIORegDepth+2) + `</array>`),
		macGPUPlist(`<array><string>` + strings.Repeat("x", maxIORegScalarBytes+1) + `</string></array>`),
		macGPUPlist(`<array>` + strings.Repeat(`<dict/>`, maxIORegValues+1) + `</array>`),
		[]byte(`<!DOCTYPE plist [<!ENTITY steal SYSTEM "file:///not-read">]><plist><array><string>&steal;</string></array></plist>`),
		append(macGPUPlist(`<array/>`), []byte(`<plist><array/></plist>`)...), []byte(strings.Repeat("x", maxIORegGPUBytes+1)),
	}
	for index, data := range invalid {
		devices, codes := parseIORegGPU(data, nil, 1)
		if len(devices) != 0 || (!macGPUHasCode(codes, "gpu:ioreg-invalid-output") && !macGPUHasCode(codes, "gpu:ioreg-output-limit")) {
			t.Fatalf("invalid plist %d accepted", index)
		}
	}
	if _, err := decodeIORegPlist(macGPUPlist(`<array><dict><key>blob</key><data> AQID\n </data><key>on</key><true/><key>off</key><false/><key>date</key><date>2026-10-28T00:00:00Z</date></dict></array>`)); err == nil {
		t.Fatal("literal backslash in base64 was silently accepted")
	}
	if _, err := decodeIORegPlist(macGPUPlist("<array><dict><key>blob</key><data> AQID\n </data><key>on</key><true/><key>off</key><false/></dict></array>")); err != nil {
		t.Fatal(err)
	}
}

func TestMacGPUUnsupportedVendorsAndUnavailableStatistics(t *testing.T) {
	apple := macGPUEntry("1", "AGXAccelerator", `<key>vendor-id</key><integer>4203</integer><key>model</key><string>Apple M1</string>`, `<key>Device Utilization %</key><integer>50</integer>`)
	devices, codes := parseIORegGPU(macGPUPlist("<array>"+apple+"</array>"), nil, 1)
	if len(devices) != 0 || !macGPUHasCode(codes, "gpu:ioreg-no-supported-driver") {
		t.Fatal("unrequested vendor was presented as Intel/AMD/NVIDIA")
	}
	missing := `<dict><key>IORegistryEntryID</key><integer>2</integer><key>IOClass</key><string>NVAccelerator</string><key>IOMatchCategory</key><string>IOAccelerator</string></dict>`
	devices, codes = parseIORegGPU(macGPUPlist("<array>"+missing+"</array>"), nil, 1)
	if len(devices) != 1 || devices[0].UtilizationPercent != nil || !macGPUHasCode(codes, "gpu:ioreg-statistics-unavailable") {
		t.Fatal("missing driver statistics hidden or fabricated")
	}
}
