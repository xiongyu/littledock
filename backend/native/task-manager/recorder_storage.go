package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const recorderSegmentBytes = 4 * 1024 * 1024
const recorderSegmentEntries = 4096

var recorderSegmentName = regexp.MustCompile(`^[0-9]{13}-[0-9a-f]{24}$`)

type recorderIndex struct {
	At                      int64
	Sequence                uint64
	Offset                  uint64
	Length                  uint32
	Sample                  bool
	CPU                     float64
	MemoryTotal, MemoryUsed uint64
	CPUCount, ProcessCount  uint32
	DiskScore, GPUScore     float64
	Interval                uint32
	GapCode                 uint32
	GapFrom                 int64
	DiskActive              float64
	GapTo                   int64
	Boot                    uint64
}

func (value recorderIndex) encode() []byte {
	data := make([]byte, recorderIndexSize)
	copy(data[:8], []byte("WNRIDX01"))
	binary.LittleEndian.PutUint64(data[8:16], uint64(value.At))
	binary.LittleEndian.PutUint64(data[16:24], value.Sequence)
	binary.LittleEndian.PutUint64(data[24:32], value.Offset)
	binary.LittleEndian.PutUint32(data[32:36], value.Length)
	if value.Sample {
		data[36] = 1
	}
	binary.LittleEndian.PutUint64(data[40:48], math.Float64bits(value.CPU))
	binary.LittleEndian.PutUint64(data[48:56], value.MemoryTotal)
	binary.LittleEndian.PutUint64(data[56:64], value.MemoryUsed)
	binary.LittleEndian.PutUint32(data[64:68], value.CPUCount)
	binary.LittleEndian.PutUint32(data[68:72], value.ProcessCount)
	binary.LittleEndian.PutUint64(data[72:80], math.Float64bits(value.DiskScore))
	binary.LittleEndian.PutUint64(data[80:88], math.Float64bits(value.GPUScore))
	binary.LittleEndian.PutUint32(data[88:92], value.Interval)
	binary.LittleEndian.PutUint32(data[92:96], value.GapCode)
	binary.LittleEndian.PutUint64(data[96:104], uint64(value.GapFrom))
	binary.LittleEndian.PutUint64(data[104:112], math.Float64bits(value.DiskActive))
	binary.LittleEndian.PutUint64(data[112:120], uint64(value.GapTo))
	binary.LittleEndian.PutUint64(data[120:128], value.Boot)
	return data
}
func recorderDecodeIndex(data []byte) (recorderIndex, error) {
	if len(data) != recorderIndexSize || string(data[:8]) != "WNRIDX01" || data[36] > 1 {
		return recorderIndex{}, fail("HISTORY_CORRUPT", "Historical index is invalid")
	}
	value := recorderIndex{At: int64(binary.LittleEndian.Uint64(data[8:16])), Sequence: binary.LittleEndian.Uint64(data[16:24]), Offset: binary.LittleEndian.Uint64(data[24:32]), Length: binary.LittleEndian.Uint32(data[32:36]), Sample: data[36] == 1, CPU: math.Float64frombits(binary.LittleEndian.Uint64(data[40:48])), MemoryTotal: binary.LittleEndian.Uint64(data[48:56]), MemoryUsed: binary.LittleEndian.Uint64(data[56:64]), CPUCount: binary.LittleEndian.Uint32(data[64:68]), ProcessCount: binary.LittleEndian.Uint32(data[68:72]), DiskScore: math.Float64frombits(binary.LittleEndian.Uint64(data[72:80])), GPUScore: math.Float64frombits(binary.LittleEndian.Uint64(data[80:88])), Interval: binary.LittleEndian.Uint32(data[88:92]), GapCode: binary.LittleEndian.Uint32(data[92:96]), GapFrom: int64(binary.LittleEndian.Uint64(data[96:104]))}
	value.DiskActive = math.Float64frombits(binary.LittleEndian.Uint64(data[104:112]))
	value.GapTo = int64(binary.LittleEndian.Uint64(data[112:120]))
	value.Boot = binary.LittleEndian.Uint64(data[120:128])
	if value.At < 0 || value.At > maxSafeNumber || value.Sequence > maxSafeNumber || value.Offset > recorderSegmentBytes+recorderMaxRaw+4096 || value.Length > recorderMaxRaw+4096 || value.GapCode > 5 || value.GapFrom < 0 || value.GapFrom > value.At || value.GapTo < 0 || value.GapTo > maxSafeNumber || value.GapCode != 0 && value.GapTo < value.GapFrom || (!math.IsNaN(value.DiskActive) && (!finiteNonnegative(value.DiskActive) || value.DiskActive > 100)) || value.MemoryUsed > value.MemoryTotal || value.MemoryTotal > maxSafeNumber || value.CPUCount > 65536 || value.ProcessCount > 1000000 || (!math.IsNaN(value.CPU) && (!finiteNonnegative(value.CPU) || value.CPU > 100)) || !finiteNonnegative(value.DiskScore) || !finiteNonnegative(value.GPUScore) || value.GPUScore > 100 {
		return value, fail("HISTORY_CORRUPT", "Historical index is invalid")
	}
	return value, nil
}

type recorderSegment struct {
	Base, IndexPath, DataPath string
	Bytes                     int64
	Count                     int
	First, Last               int64
	Corrupt                   bool
}

func recorderReadIndex(file *os.File, number int) (recorderIndex, error) {
	buffer := make([]byte, recorderIndexSize)
	if _, err := file.ReadAt(buffer, int64(number)*recorderIndexSize); err != nil {
		return recorderIndex{}, err
	}
	return recorderDecodeIndex(buffer)
}
func recorderSegments(directory string) ([]recorderSegment, int64, error) {
	result := []recorderSegment{}
	var stored, indexBytes int64
	file, err := os.Open(directory)
	if errors.Is(err, os.ErrNotExist) {
		return result, 0, nil
	}
	if err != nil {
		return nil, 0, fail("RECORDING_STORAGE_FAILED", "Recording storage is unavailable")
	}
	defer file.Close()
	entries, err := file.ReadDir(recorderMaxSegments*3 + 32)
	if err != nil && err != io.EOF {
		return nil, 0, err
	}
	if len(entries) >= recorderMaxSegments*3+32 {
		return nil, 0, fail("RECORDING_STORAGE_FAILED", "Recording file limit exceeded")
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		stored += info.Size()
		base := strings.TrimSuffix(entry.Name(), ".index")
		if base == entry.Name() || !recorderSegmentName.MatchString(base) {
			continue
		}
		if len(result) >= recorderMaxSegments {
			return nil, stored, fail("HISTORY_CORRUPT", "Historical index limit exceeded")
		}
		indexBytes += info.Size()
		count := int(info.Size() / recorderIndexSize)
		if count == 0 {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		dataPath := filepath.Join(directory, base+".data")
		dataInfo, dataErr := os.Lstat(dataPath)
		stamp, _ := strconv.ParseInt(base[:13], 10, 64)
		segment := recorderSegment{Base: base, IndexPath: path, DataPath: dataPath, Bytes: info.Size(), Count: count, First: stamp, Last: stamp + 3600000}
		if dataErr == nil && dataInfo.Mode().IsRegular() {
			segment.Bytes += dataInfo.Size()
		}
		segment.Corrupt = info.Size() > recorderSegmentEntries*recorderIndexSize || indexBytes > recorderMaxIndexBytes || dataErr != nil || !dataInfo.Mode().IsRegular() || dataInfo.Size() > recorderSegmentBytes+recorderMaxRaw+4096
		if !segment.Corrupt {
			index, openErr := os.Open(path)
			if openErr != nil {
				segment.Corrupt = true
			} else {
				first, e1 := recorderReadIndex(index, 0)
				last, e2 := recorderReadIndex(index, count-1)
				index.Close()
				segment.Corrupt = e1 != nil || e2 != nil || last.At < first.At
				if !segment.Corrupt {
					segment.First = first.At
					segment.Last = last.At
				}
			}
		}
		result = append(result, segment)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].First == result[j].First {
			return result[i].Base < result[j].Base
		}
		return result[i].First < result[j].First
	})
	return result, stored, nil
}
func recorderAvailability(segments []recorderSegment, cutoff int64) (*int64, *int64) {
	var first, last *int64
	for _, segment := range segments {
		if segment.Last < cutoff || segment.Corrupt {
			continue
		}
		file, err := os.Open(segment.IndexPath)
		if err != nil {
			continue
		}
		low, high := 0, segment.Count
		for low < high {
			middle := (low + high) / 2
			entry, err := recorderReadIndex(file, middle)
			if err != nil {
				low = segment.Count
				break
			}
			if entry.At < cutoff {
				low = middle + 1
			} else {
				high = middle
			}
		}
		for i := low; i < segment.Count; i++ {
			entry, err := recorderReadIndex(file, i)
			if err != nil {
				break
			}
			if entry.Sample {
				at := entry.At
				if first == nil || at < *first {
					first = &at
				}
				break
			}
		}
		for i := segment.Count - 1; i >= low; i-- {
			entry, err := recorderReadIndex(file, i)
			if err != nil {
				break
			}
			if entry.Sample {
				at := entry.At
				if last == nil || at > *last {
					last = &at
				}
				break
			}
		}
		file.Close()
	}
	return first, last
}

type recorderWriter struct {
	directory, base string
	data, index     *os.File
	bytes           int64
	entries         int
	started         int64
	lastAt          int64
}

func (writer *recorderWriter) close() {
	if writer.data != nil {
		writer.data.Close()
		writer.data = nil
	}
	if writer.index != nil {
		writer.index.Close()
		writer.index = nil
	}
	if writer.entries == 0 && recorderSegmentName.MatchString(writer.base) {
		_ = os.Remove(filepath.Join(writer.directory, writer.base+".index"))
		_ = os.Remove(filepath.Join(writer.directory, writer.base+".data"))
	}
}
func (writer *recorderWriter) rotate(at int64) error {
	writer.close()
	token := recorderToken()
	if token == "" {
		return errors.New("random source unavailable")
	}
	writer.base = fmt.Sprintf("%013d-%s", at, token)
	writer.started = at
	writer.entries = 0
	writer.bytes = 0
	var err error
	writer.data, err = os.OpenFile(filepath.Join(writer.directory, writer.base+".data"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	writer.index, err = os.OpenFile(filepath.Join(writer.directory, writer.base+".index"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		writer.close()
	}
	return err
}
func (writer *recorderWriter) prune(settings recordingSettings, at int64, incoming int64) error {
	segments, stored, err := recorderSegments(writer.directory)
	if err != nil {
		return err
	}
	cutoff := at - int64(settings.RetentionDays)*86400000
	remaining := len(segments)
	for _, segment := range segments {
		if segment.Base == writer.base {
			continue
		}
		if segment.Last >= cutoff && stored+incoming <= int64(settings.MaxMiB)*1024*1024 && remaining < recorderMaxSegments-2 {
			continue
		}
		// Exact internal segment names only; no user-supplied deletion paths.
		if err := os.Remove(segment.IndexPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Remove(segment.DataPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		stored -= segment.Bytes
		remaining--
	}
	if stored+incoming > int64(settings.MaxMiB)*1024*1024 {
		return errors.New("recording storage capacity reached")
	}
	return nil
}
func recorderGapReason(code uint32) string {
	switch code {
	case 1:
		return "sampling-delayed"
	case 2:
		return "capture-failed"
	case 3:
		return "storage-failed"
	case 4:
		return "recorder-interrupted"
	case 5:
		return "clock-change"
	}
	return ""
}
func (writer *recorderWriter) append(point *historyPoint, at int64, gapFrom int64, gapCode uint32, settings recordingSettings) error {
	previousAt := writer.lastAt
	if writer.data == nil || writer.bytes >= recorderSegmentBytes || writer.entries >= recorderSegmentEntries || at-writer.started >= 3600000 || at < writer.lastAt {
		if err := writer.rotate(at); err != nil {
			return err
		}
	}
	entry := recorderIndex{At: at, CPU: math.NaN(), DiskActive: math.NaN(), Interval: uint32(settings.IntervalSeconds), GapFrom: gapFrom, GapCode: gapCode, GapTo: at}
	if previousAt > at {
		entry.GapCode = 5
		entry.GapFrom = at
		entry.GapTo = previousAt
	}
	var encoded []byte
	if point != nil {
		point.ID = fmt.Sprintf("%s:%d", writer.base, writer.entries)
		raw, err := json.Marshal(point)
		if err != nil || len(raw) > recorderMaxRaw {
			return errors.New("record exceeds size limit")
		}
		var compressed bytes.Buffer
		gzipWriter, _ := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
		if _, err = gzipWriter.Write(raw); err != nil {
			return err
		}
		if err = gzipWriter.Close(); err != nil {
			return err
		}
		encoded = compressed.Bytes()
		if len(encoded) > recorderMaxRaw+4096 {
			return errors.New("compressed record exceeds size limit")
		}
		entry.Sample = true
		boot := sha256.Sum256([]byte(point.BootID))
		entry.Boot = binary.LittleEndian.Uint64(boot[:8])
		entry.Sequence = point.Sequence
		entry.Offset = uint64(writer.bytes)
		entry.Length = uint32(len(encoded))
		entry.MemoryTotal = point.Memory.Total
		entry.MemoryUsed = point.Memory.Used
		entry.CPUCount = uint32(point.CPUCount)
		entry.ProcessCount = uint32(point.ProcessCount)
		if point.CPUPercent != nil {
			entry.CPU = *point.CPUPercent
		}
		if point.Disk != nil {
			if point.Disk.ActivePercent != nil {
				entry.DiskActive = *point.Disk.ActivePercent
			}
			if point.Disk.ReadBytesPerSecond != nil {
				entry.DiskScore += *point.Disk.ReadBytesPerSecond
			}
			if point.Disk.WriteBytesPerSecond != nil {
				entry.DiskScore += *point.Disk.WriteBytesPerSecond
			}
		}
		if point.GPU != nil && point.GPU.UtilizationPercent != nil {
			entry.GPUScore = *point.GPU.UtilizationPercent
		}
	}
	if err := writer.prune(settings, at, int64(len(encoded)+recorderIndexSize)); err != nil {
		return err
	}
	if len(encoded) > 0 {
		if _, err := writer.data.Write(encoded); err != nil {
			writer.close()
			return err
		}
		if err := writer.data.Sync(); err != nil {
			writer.close()
			return err
		}
		writer.bytes += int64(len(encoded))
	}
	if _, err := writer.index.Write(entry.encode()); err != nil {
		writer.close()
		return err
	}
	if err := writer.index.Sync(); err != nil {
		writer.close()
		return err
	}
	writer.entries++
	writer.lastAt = at
	return nil
}
func recorderReadPoint(directory, id string) (historyPoint, error) {
	point := historyPoint{}
	if err := recorderCheckDirectory(directory, false); err != nil {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample is unavailable")
	}
	base, position, ok := strings.Cut(id, ":")
	number, err := strconv.Atoi(position)
	if !ok || !recorderSegmentName.MatchString(base) || err != nil || number < 0 || number >= recorderSegmentEntries {
		return point, fail("INVALID_REQUEST", "Invalid historical sample ID")
	}
	indexPath := filepath.Join(directory, base+".index")
	info, err := os.Lstat(indexPath)
	if err != nil {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample has expired or is unavailable")
	}
	if !info.Mode().IsRegular() {
		return point, fail("HISTORY_CORRUPT", "Historical index is invalid")
	}
	index, err := os.Open(indexPath)
	if err != nil {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample is unavailable")
	}
	entry, err := recorderReadIndex(index, number)
	index.Close()
	if err != nil || !entry.Sample {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample is unavailable")
	}
	config, err := recorderLoadConfig(directory)
	if err != nil {
		return point, err
	}
	if entry.At < time.Now().UnixMilli()-int64(config.RetentionDays)*86400000 {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample has expired")
	}
	dataPath := filepath.Join(directory, base+".data")
	info, err = os.Lstat(dataPath)
	if err != nil {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample is unavailable")
	}
	if !info.Mode().IsRegular() || entry.Offset+uint64(entry.Length) > uint64(info.Size()) {
		return point, fail("HISTORY_CORRUPT", "Historical payload is invalid")
	}
	file, err := os.Open(dataPath)
	if err != nil {
		return point, fail("HISTORY_NOT_FOUND", "Historical sample is unavailable")
	}
	defer file.Close()
	reader, err := gzip.NewReader(io.NewSectionReader(file, int64(entry.Offset), int64(entry.Length)))
	if err != nil {
		return point, fail("HISTORY_CORRUPT", "Historical payload is invalid")
	}
	defer reader.Close()
	reader.Multistream(false)
	raw, err := io.ReadAll(io.LimitReader(reader, recorderMaxRaw+1))
	if err != nil || len(raw) > recorderMaxRaw {
		return point, fail("HISTORY_CORRUPT", "Historical payload limit exceeded")
	}
	if err := decodeStrict(raw, &point); err != nil || point.ID != id || point.SampledAt != entry.At || point.Sequence != entry.Sequence || len(point.Processes) > 40 {
		return historyPoint{}, fail("HISTORY_CORRUPT", "Historical sample is invalid")
	}
	return point, nil
}

type historyQuery struct {
	From      int64 `json:"from"`
	To        int64 `json:"to"`
	MaxPoints int   `json:"maxPoints,omitempty"`
}
type recorderCandidate struct {
	base   string
	number int
	entry  recorderIndex
}
type recorderBucket struct{ cpu, memory, disk, gpu, last *recorderCandidate }

func recorderMemoryScore(entry recorderIndex) float64 {
	if entry.MemoryTotal == 0 {
		return 0
	}
	return float64(entry.MemoryUsed) / float64(entry.MemoryTotal)
}
func recorderDiskHigher(a, b recorderIndex) bool {
	aa, bb := a.DiskActive, b.DiskActive
	if math.IsNaN(aa) {
		aa = -1
	}
	if math.IsNaN(bb) {
		bb = -1
	}
	if aa != bb {
		return aa > bb
	}
	return a.DiskScore > b.DiskScore
}
func recorderAddGap(page *historyPage, from, to int64, reason string) {
	if from < page.From {
		from = page.From
	}
	if to > page.To {
		to = page.To
	}
	if from > to {
		return
	}
	if len(page.Gaps) > 0 {
		last := &page.Gaps[len(page.Gaps)-1]
		if last.Reason == reason && from <= last.To+1000 {
			if to > last.To {
				last.To = to
			}
			return
		}
	}
	if len(page.Gaps) >= 100 {
		page.Truncated = true
		return
	}
	page.Gaps = append(page.Gaps, historyGap{from, to, reason})
}
func recorderQuery(ctx context.Context, directory string, params historyQuery) (historyPage, error) {
	page := historyPage{From: params.From, To: params.To, Points: []historySummary{}, Gaps: []historyGap{}}
	if params.From < 0 || params.To < params.From || params.To > maxSafeNumber || params.To-params.From > 31*86400000 || params.MaxPoints < 0 || params.MaxPoints > 300 {
		return page, fail("INVALID_REQUEST", "Invalid historical time range")
	}
	if params.MaxPoints == 0 {
		params.MaxPoints = 300
	}
	if err := recorderCheckDirectory(directory, false); errors.Is(err, os.ErrNotExist) {
		return page, nil
	} else if err != nil {
		return page, err
	}
	config, err := recorderLoadConfig(directory)
	if err != nil {
		return page, err
	}
	cutoff := time.Now().UnixMilli() - int64(config.RetentionDays)*86400000
	segments, _, err := recorderSegments(directory)
	if err != nil {
		return page, err
	}
	page.AvailableFrom, page.AvailableTo = recorderAvailability(segments, cutoff)
	bucketCount := params.MaxPoints / 5
	if bucketCount < 1 {
		bucketCount = 1
	}
	buckets := make([]recorderBucket, bucketCount)
	var scanned int64
	var previous *recorderIndex
	all := []*recorderCandidate{}
	for _, segment := range segments {
		if segment.Last < params.From || segment.First > params.To || segment.Last < cutoff {
			continue
		}
		if segment.Corrupt {
			page.Truncated = true
			recorderAddGap(&page, segment.First, segment.Last, "history-corrupt")
			continue
		}
		file, err := os.Open(segment.IndexPath)
		if err != nil {
			page.Truncated = true
			recorderAddGap(&page, segment.First, segment.Last, "history-corrupt")
			continue
		}
		buffer := make([]byte, segment.Count*recorderIndexSize)
		_, readErr := file.ReadAt(buffer, 0)
		file.Close()
		if readErr != nil {
			page.Truncated = true
			recorderAddGap(&page, segment.First, segment.Last, "history-corrupt")
			continue
		}
		for index := 0; index < segment.Count; index++ {
			if ctx.Err() != nil || scanned >= recorderMaxIndexBytes {
				page.Truncated = true
				recorderAddGap(&page, segment.First, params.To, "query-limit")
				return recorderSelectedPage(ctx, directory, page, buckets, params.MaxPoints), nil
			}
			entry, err := recorderDecodeIndex(buffer[index*recorderIndexSize : (index+1)*recorderIndexSize])
			scanned += recorderIndexSize
			if err != nil {
				page.Truncated = true
				recorderAddGap(&page, segment.First, segment.Last, "history-corrupt")
				break
			}
			if entry.At < params.From || entry.At > params.To || entry.At < cutoff {
				continue
			}
			if entry.GapCode != 0 {
				recorderAddGap(&page, entry.GapFrom, entry.GapTo, recorderGapReason(entry.GapCode))
			} else if previous != nil && previous.Boot != 0 && entry.Boot != 0 && previous.Boot != entry.Boot {
				recorderAddGap(&page, previous.At, entry.At, "recorder-interrupted")
			} else if previous != nil && entry.At-previous.At > int64(previous.Interval)*1000+1500 {
				recorderAddGap(&page, previous.At+int64(previous.Interval)*1000, entry.At, "recorder-interrupted")
			}
			copyEntry := entry
			previous = &copyEntry
			if !entry.Sample {
				continue
			}
			page.TotalSamples++
			bucketIndex := int((entry.At - params.From) * int64(bucketCount) / (params.To - params.From + 1))
			if bucketIndex >= bucketCount {
				bucketIndex = bucketCount - 1
			}
			bucket := &buckets[bucketIndex]
			candidate := &recorderCandidate{segment.Base, index, entry}
			if len(all) < params.MaxPoints+1 {
				all = append(all, candidate)
			}
			if bucket.cpu == nil || math.IsNaN(bucket.cpu.entry.CPU) || (!math.IsNaN(entry.CPU) && entry.CPU > bucket.cpu.entry.CPU) {
				bucket.cpu = candidate
			}
			if bucket.memory == nil || recorderMemoryScore(entry) > recorderMemoryScore(bucket.memory.entry) {
				bucket.memory = candidate
			}
			if bucket.disk == nil || recorderDiskHigher(entry, bucket.disk.entry) {
				bucket.disk = candidate
			}
			if bucket.gpu == nil || entry.GPUScore > bucket.gpu.entry.GPUScore {
				bucket.gpu = candidate
			}
			if bucket.last == nil || entry.At >= bucket.last.entry.At {
				bucket.last = candidate
			}
		}
	}
	if len(segments) > 0 {
		last := segments[len(segments)-1]
		if last.Last < params.To {
			file, err := os.Open(last.IndexPath)
			if err == nil {
				entry, readErr := recorderReadIndex(file, last.Count-1)
				file.Close()
				end := params.To
				if now := time.Now().UnixMilli(); end > now {
					end = now
				}
				if readErr == nil && end-entry.At > int64(entry.Interval)*1000+1500 {
					recorderAddGap(&page, entry.At+int64(entry.Interval)*1000, end, "recorder-interrupted")
				}
			}
		}
	}
	if len(all) <= params.MaxPoints {
		buckets = make([]recorderBucket, len(all))
		for i, item := range all {
			buckets[i].last = item
		}
	}
	return recorderSelectedPage(ctx, directory, page, buckets, params.MaxPoints), nil
}
func recorderSelectedPage(ctx context.Context, directory string, page historyPage, buckets []recorderBucket, maxPoints int) historyPage {
	seen := make(map[string]bool)
	candidates := []*recorderCandidate{}
	for _, bucket := range buckets {
		for _, item := range []*recorderCandidate{bucket.cpu, bucket.memory, bucket.disk, bucket.gpu, bucket.last} {
			if item == nil {
				continue
			}
			id := fmt.Sprintf("%s:%d", item.base, item.number)
			if !seen[id] {
				seen[id] = true
				candidates = append(candidates, item)
			}
		}
	}
	if len(candidates) > maxPoints {
		candidates = candidates[:maxPoints]
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].entry.At < candidates[j].entry.At })
	for _, item := range candidates {
		if ctx.Err() != nil {
			page.Truncated = true
			recorderAddGap(&page, item.entry.At, page.To, "query-limit")
			break
		}
		point, err := recorderReadPoint(directory, fmt.Sprintf("%s:%d", item.base, item.number))
		if err != nil {
			page.Truncated = true
			recorderAddGap(&page, item.entry.At, item.entry.At, "history-corrupt")
			continue
		}
		page.Points = append(page.Points, point.historySummary)
	}
	if page.TotalSamples > len(page.Points) {
		page.Truncated = true
	}
	return page
}
