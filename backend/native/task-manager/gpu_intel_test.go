package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func intelFixture(t *testing.T, driver, id, owner, pci, engine string, at time.Time) intelClientSample {
	t.Helper()
	sample, err := parseIntelFDInfo([]byte("drm-driver: "+driver+"\ndrm-client-id: "+id+"\ndrm-pdev: "+pci+"\n"+engine), owner, at)
	if err != nil {
		t.Fatal(err)
	}
	return sample
}
func intelFixtureScan(samples ...intelClientSample) intelScan {
	scan := intelScan{clients: make(map[string]intelClientSample)}
	for _, sample := range samples {
		mergeIntelClient(scan.clients, sample)
	}
	return scan
}
func intelHas(reasons []string, value string) bool {
	for _, reason := range reasons {
		if reason == value {
			return true
		}
	}
	return false
}
func intelAssertPercent(t *testing.T, values map[string]*float64, pci string, want float64) {
	t.Helper()
	actual := values[pci]
	if actual == nil || math.Abs(*actual-want) > 0.000001 {
		t.Fatalf("expected %v, got %v", want, actual)
	}
}

func TestIntelFDInfoDeduplicatesClientsAndPreservesIndependentAdapters(t *testing.T) {
	start := time.Unix(100, 0)
	history := intelGPUHistory{}
	pci := "0000:00:02.0"
	discrete := "0000:03:00.0"
	first := intelFixture(t, "i915", "7", "100:2", pci, "drm-engine-render: 1000000000 ns\n", start)
	duplicate := intelFixture(t, "i915", "7", "200:3", pci, "drm-engine-render: 1000000000 ns\n", start)
	other := intelFixture(t, "i915", "7", "100:2", discrete, "drm-engine-render: 1000000000 ns\n", start)
	scan := intelFixtureScan(first, duplicate, other)
	if len(scan.clients) != 2 {
		t.Fatal("shared descriptors duplicated or independent GPU merged")
	}
	values, reasons := history.sample(scan, start)
	if values[pci] != nil || !intelHas(reasons, "gpu:intel-warming-up") {
		t.Fatal("first sample fabricated")
	}
	second := intelFixture(t, "i915", "7", "200:3", pci, "drm-engine-render: 1250000000 ns\n", start.Add(time.Second))
	secondDuplicate := intelFixture(t, "i915", "7", "100:2", pci, "drm-engine-render: 1250000000 ns\n", start.Add(time.Second))
	secondOther := intelFixture(t, "i915", "7", "100:2", discrete, "drm-engine-render: 1750000000 ns\n", start.Add(time.Second))
	values, _ = history.sample(intelFixtureScan(second, secondDuplicate, secondOther), start.Add(time.Second))
	intelAssertPercent(t, values, pci, 25)
	intelAssertPercent(t, values, discrete, 75)
	idle := intelFixture(t, "i915", "7", "200:3", pci, "drm-engine-render: 1250000000 ns\n", start.Add(2*time.Second))
	values, _ = history.sample(intelFixtureScan(idle), start.Add(2*time.Second))
	intelAssertPercent(t, values, pci, 0)
}

func TestIntelXeCyclesNormalizeCapacityAndSumVisibleClients(t *testing.T) {
	pci := "0000:03:00.0"
	at := time.Unix(100, 0)
	history := intelGPUHistory{}
	create := func(id, busy, total string, now time.Time) intelClientSample {
		return intelFixture(t, "xe", id, "5:10", pci, "drm-cycles-ccs: "+busy+"\ndrm-total-cycles-ccs: "+total+"\ndrm-engine-capacity-ccs: 4\n", now)
	}
	history.sample(intelFixtureScan(create("1", "100", "1000", at), create("2", "200", "1000", at)), at)
	values, _ := history.sample(intelFixtureScan(create("1", "300", "1200", at.Add(time.Second)), create("2", "400", "1200", at.Add(time.Second))), at.Add(time.Second))
	intelAssertPercent(t, values, pci, 50)
	// A GPU clock reset is unknown for this interval, never a negative or idle result.
	values, reasons := history.sample(intelFixtureScan(create("1", "350", "1100", at.Add(2*time.Second))), at.Add(2*time.Second))
	if values[pci] != nil || !intelHas(reasons, "gpu:intel-counter-reset") {
		t.Fatal("reset fabricated")
	}
}

func TestIntelCounterRegressionHighWaterAndReusedClientIdentity(t *testing.T) {
	pci := "0000:00:02.0"
	at := time.Unix(100, 0)
	history := intelGPUHistory{}
	create := func(busy, owner string, seconds int) intelClientSample {
		return intelFixture(t, "i915", "1", owner, pci, "drm-engine-render: "+busy+" ns\n", at.Add(time.Duration(seconds)*time.Second))
	}
	history.sample(intelFixtureScan(create("1000000000", "12:1", 0)), at)
	values, reasons := history.sample(intelFixtureScan(create("900000000", "12:1", 1)), at.Add(time.Second))
	if values[pci] != nil || !intelHas(reasons, "gpu:intel-counter-reset") {
		t.Fatal("counter regression accepted")
	}
	values, _ = history.sample(intelFixtureScan(create("1500000000", "12:1", 2)), at.Add(2*time.Second))
	intelAssertPercent(t, values, pci, 25)
	values, reasons = history.sample(intelFixtureScan(create("1800000000", "12:2", 3)), at.Add(3*time.Second))
	if values[pci] != nil || !intelHas(reasons, "gpu:intel-warming-up") {
		t.Fatal("PID/client reuse inherited baseline")
	}
	values, _ = history.sample(intelFixtureScan(create("1900000000", "12:2", 4)), at.Add(4*time.Second))
	intelAssertPercent(t, values, pci, 10)
	history.sample(intelScan{clients: map[string]intelClientSample{}}, at.Add(5*time.Second))
	if len(history.clients) != 0 {
		t.Fatal("departed clients retained")
	}
}

func TestIntelParserRejectsAmbiguityAndBounds(t *testing.T) {
	base := "drm-driver: i915\ndrm-client-id: 1\ndrm-pdev: 0000:00:02.0\n"
	bad := []string{base + "drm-client-id: 2\n", base + "drm-engine-render: -1 ns\n", base + "drm-engine-render: 1 us\n", base + "drm-engine-render: 1 ns\ndrm-engine-capacity-render: 0\n", base + strings.Repeat("x", intelMaxFDBytes), strings.Replace(base, "0000:00:02.0", "0000:00:ff.0", 1)}
	for _, data := range bad {
		if _, err := parseIntelFDInfo([]byte(data), "1:2", time.Now()); err == nil {
			t.Fatalf("accepted invalid fdinfo: %.160s", data)
		}
	}
	many := base
	for i := 0; i <= intelMaxEngines; i++ {
		many += fmt.Sprintf("drm-engine-e%d: 0 ns\n", i)
	}
	if _, err := parseIntelFDInfo([]byte(many), "1:2", time.Now()); err == nil {
		t.Fatal("unbounded engine list")
	}
	if normalizeGPUPCI("00000000:AF:02.0") != "0000:af:02.0" || normalizeGPUPCI("00010000:00:02.0") != "" {
		t.Fatal("invalid PCI normalization")
	}
	history := intelGPUHistory{}
	_, reasons := history.sample(intelScan{denied: true, limited: true, malformed: true, unavailable: true}, time.Now())
	for _, reason := range []string{"gpu:intel-visible-clients", "gpu:intel-fdinfo-permission-denied", "gpu:intel-fdinfo-truncated", "gpu:intel-fdinfo-invalid", "gpu:intel-fdinfo-unavailable"} {
		if !intelHas(reasons, reason) {
			t.Fatal("missing coverage reason", reason)
		}
	}
}

func intelWriteProc(t *testing.T, root, pid, start string, fdBodies map[string]string) {
	t.Helper()
	directory := filepath.Join(root, pid, "fdinfo")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	fields := make([]string, 20)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = "S"
	fields[19] = start
	if err := os.WriteFile(filepath.Join(root, pid, "stat"), []byte(pid+" (weird ) process) "+strings.Join(fields, " ")), 0600); err != nil {
		t.Fatal(err)
	}
	for fd, body := range fdBodies {
		if err := os.WriteFile(filepath.Join(directory, fd), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestIntelProcScanReadsCreationIdentityDeduplicatesAndBounds(t *testing.T) {
	root := t.TempDir()
	body := "drm-driver: i915\ndrm-client-id: 7\ndrm-pdev: 0000:00:02.0\ndrm-engine-render: 1 ns\n"
	intelWriteProc(t, root, "1", "123", map[string]string{"4": body, "5": body})
	intelWriteProc(t, root, "2", "456", map[string]string{"6": body})
	scan := scanIntelFDInfo(context.Background(), root, map[string]bool{"0000:00:02.0": true})
	if len(scan.clients) != 1 || scan.limited || scan.denied {
		t.Fatalf("bad scan %+v", scan)
	}
	for _, client := range scan.clients {
		if !client.owners["1:123"] || !client.owners["2:456"] {
			t.Fatal("creation identity lost")
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if scan := scanIntelFDInfo(canceled, root, map[string]bool{"0000:00:02.0": true}); !scan.limited || len(scan.clients) != 0 {
		t.Fatal("canceled scan not bounded")
	}
	large := filepath.Join(root, "oversized")
	if err := os.WriteFile(large, []byte(strings.Repeat("x", intelMaxFDBytes+10)), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := readIntelBounded(large, intelMaxFDBytes)
	if err != io.ErrShortBuffer || len(data) != intelMaxFDBytes+1 {
		t.Fatal("oversized reads not charged to byte budget")
	}
	fds := make(map[string]string)
	for i := 0; i < 513; i++ {
		fds[fmt.Sprint(i)] = body
	}
	intelWriteProc(t, root, "3", "789", fds)
	if scan := scanIntelFDInfo(context.Background(), root, map[string]bool{"0000:00:02.0": true}); !scan.limited {
		t.Fatal("fd scan cap not visible")
	}
}

type intelMemoryFixtureRegion struct {
	class, instance uint16
	total, used     uint64
}

func intelMemoryFixture(driver string, regions ...intelMemoryFixtureRegion) []byte {
	header := 16
	if driver == "xe" {
		header = 8
	}
	data := make([]byte, header+88*len(regions))
	binary.LittleEndian.PutUint32(data, uint32(len(regions)))
	for i, region := range regions {
		p := data[header+i*88:]
		binary.LittleEndian.PutUint16(p, region.class)
		binary.LittleEndian.PutUint16(p[2:], region.instance)
		binary.LittleEndian.PutUint64(p[8:], region.total)
		binary.LittleEndian.PutUint64(p[16:], region.used)
	}
	return data
}
func TestIntelMemoryQueryRequiresDeviceWidePrivilegeAndSeparatesSystemMemory(t *testing.T) {
	data := intelMemoryFixture("xe", intelMemoryFixtureRegion{1, 0, 8 << 30, 2 << 30}, intelMemoryFixtureRegion{0, 0, 32 << 30, 3 << 30})
	unprivileged, err := parseIntelMemoryRegions("xe", data, false)
	if err != nil || unprivileged.localUsed == nil || *unprivileged.localUsed != 2<<30 || unprivileged.sharedUsed == nil || *unprivileged.sharedUsed != 3<<30 {
		t.Fatalf("Xe counters unnecessarily hidden %+v %v", unprivileged, err)
	}
	memory, err := parseIntelMemoryRegions("xe", data, true)
	if err != nil || *memory.localUsed != 2<<30 || *memory.sharedUsed != 3<<30 {
		t.Fatalf("wrong separated memory %+v %v", memory, err)
	}
	data = intelMemoryFixture("i915", intelMemoryFixtureRegion{1, 0, 8 << 30, 6 << 30}, intelMemoryFixtureRegion{0, 0, 32 << 30, 32 << 30})
	hidden, err := parseIntelMemoryRegions("i915", data, false)
	if err != nil || hidden.localTotal == nil || *hidden.localTotal != 8<<30 || hidden.localUsed != nil || hidden.sharedUsed != nil {
		t.Fatalf("i915 privileged counters fabricated %+v %v", hidden, err)
	}
	memory, err = parseIntelMemoryRegions("i915", data, true)
	if err != nil || *memory.localUsed != 2<<30 || memory.sharedUsed != nil {
		t.Fatal("i915 unallocated or system RAM misinterpreted")
	}
	oldKernel := intelMemoryFixture("i915", intelMemoryFixtureRegion{1, 0, 8 << 30, 8 << 30})
	old, err := parseIntelMemoryRegions("i915", oldKernel, true)
	if err != nil || old.localTotal == nil || old.localUsed != nil {
		t.Fatal("old i915 accounting fabricated idle memory")
	}
	for _, bad := range [][]byte{data[:len(data)-1], intelMemoryFixture("xe", intelMemoryFixtureRegion{1, 0, 8, 9}), intelMemoryFixture("xe", intelMemoryFixtureRegion{1, 0, 8, 1}, intelMemoryFixtureRegion{1, 0, 8, 1}), intelMemoryFixture("xe", intelMemoryFixtureRegion{0, 0, 1 << 52, 1 << 52}, intelMemoryFixtureRegion{0, 1, 1 << 52, 1 << 52})} {
		if _, err := parseIntelMemoryRegions("xe", bad, true); err == nil {
			t.Fatal("invalid region/overflow accepted")
		}
	}
}
