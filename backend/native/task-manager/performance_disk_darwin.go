package main

import (
	"context"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
)

func gatherDiskCounters(ctx context.Context) ([]diskCounter, []string) {
	result := []diskCounter{}
	unavailable := []string{}
	counters, err := disk.IOCountersWithContext(ctx)
	if err != nil {
		return result, []string{"disks"}
	}
	names := make([]string, 0, len(counters))
	for name := range counters {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > maxDisks {
		names = names[:maxDisks]
		unavailable = append(unavailable, "disks:truncated")
	}
	for _, name := range names {
		if ctx.Err() != nil {
			unavailable = append(unavailable, "disks:partial")
			break
		}
		stat := counters[name]
		// IOKit gives real device byte counters. gopsutil's Darwin IoTime sums
		// overlapping read/write durations, so it cannot represent active time.
		result = append(result, diskCounter{ID: name, Name: stat.Name, ReadBytes: stat.ReadBytes, WriteBytes: stat.WriteBytes, IOAvailable: true, SampledAt: time.Now()})
	}
	return result, unavailable
}
