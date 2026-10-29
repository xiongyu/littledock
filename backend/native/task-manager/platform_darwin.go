package main

import (
	"context"
	"github.com/shirou/gopsutil/v4/process"
)

func platformProcesses(ctx context.Context) ([]int32, map[int32]*processMetadata, error) {
	pids, err := process.PidsWithContext(ctx)
	return pids, nil, err
}
func platformDetails(_ context.Context, _ *process.Process, d *detailsDTO) {
	// gopsutil does not expose these Darwin diagnostics. Do not fabricate
	// empty successful results or substitute unrelated metrics.
	d.Unavailable = append(d.Unavailable, "files", "modules", "threads")
}
func terminatePlatform(_ context.Context, _ *process.Process, _ identityParams, _ bool) error {
	// PID-only signals cannot eliminate PID reuse between checking and acting.
	// Require a validated stable Mach task handle before enabling this capability.
	return fail("UNSUPPORTED", "Process termination is not available on macOS in this collector version")
}
