package main

import (
	"context"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type identityParams struct {
	PID       int32 `json:"pid"`
	StartedAt int64 `json:"startedAt"`
}
type terminateParams struct {
	PID       int32 `json:"pid"`
	StartedAt int64 `json:"startedAt"`
	Force     *bool `json:"force"`
}
type fileDTO struct {
	FD   uint64 `json:"fd"`
	Path string `json:"path"`
	Type string `json:"type"`
}
type connectionDTO struct {
	Protocol      string `json:"protocol"`
	LocalAddress  string `json:"localAddress"`
	LocalPort     uint32 `json:"localPort"`
	RemoteAddress string `json:"remoteAddress"`
	RemotePort    uint32 `json:"remotePort"`
	State         string `json:"state"`
}
type threadDTO struct {
	ID      int32    `json:"id"`
	CPUTime *float64 `json:"cpuTime,omitempty"`
	State   string   `json:"state,omitempty"`
}
type detailsDTO struct {
	Process     processDTO      `json:"process"`
	Files       []fileDTO       `json:"files"`
	Connections []connectionDTO `json:"connections"`
	Modules     []string        `json:"modules"`
	Threads     []threadDTO     `json:"threads"`
	Unavailable []string        `json:"unavailable"`
}
type terminateDTO struct {
	Status    string `json:"status"`
	PID       int32  `json:"pid"`
	StartedAt int64  `json:"startedAt"`
	Message   string `json:"message,omitempty"`
}

func checkIdentity(ctx context.Context, identity identityParams) (*process.Process, error) {
	if identity.PID <= 0 || identity.StartedAt <= 0 {
		return nil, fail("INVALID_REQUEST", "A positive process ID and creation time are required")
	}
	p, err := process.NewProcessWithContext(ctx, identity.PID)
	if err != nil {
		return nil, fail("PROCESS_UNAVAILABLE", "Process is unavailable or has exited")
	}
	start, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		return nil, fail("PROCESS_UNAVAILABLE", "Process identity cannot be verified")
	}
	if start != identity.StartedAt {
		return nil, fail("IDENTITY_MISMATCH", "Process identity changed; refresh before continuing")
	}
	return p, nil
}
func (c *collector) details(ctx context.Context, identity identityParams) (*detailsDTO, error) {
	p, err := checkIdentity(ctx, identity)
	if err != nil {
		return nil, err
	}
	item, _, err := c.readProcess(ctx, p, time.Now(), nil)
	if err != nil {
		return nil, err
	}
	d := &detailsDTO{Process: item, Files: []fileDTO{}, Connections: []connectionDTO{}, Modules: []string{}, Threads: []threadDTO{}, Unavailable: []string{}}
	platformDetails(ctx, p, d)
	connections, err := p.ConnectionsMaxWithContext(ctx, maxDetails+1)
	if runtime.GOOS == "windows" {
		connections, err = p.ConnectionsWithContext(ctx)
	}
	if err != nil {
		d.Unavailable = append(d.Unavailable, "connections")
	} else {
		for _, conn := range connections {
			if len(d.Connections) >= maxDetails {
				d.Unavailable = append(d.Unavailable, "connections:truncated")
				break
			}
			protocol := "unknown"
			if conn.Type == 1 {
				protocol = "tcp"
			}
			if conn.Type == 2 {
				protocol = "udp"
			}
			state := boundedText(conn.Status, 100)
			if protocol == "udp" {
				state = ""
			}
			d.Connections = append(d.Connections, connectionDTO{protocol, boundedText(conn.Laddr.IP, 256), conn.Laddr.Port, boundedText(conn.Raddr.IP, 256), conn.Raddr.Port, state})
		}
	}
	// A process may exit or PID may be recycled during an expensive details call.
	if _, err = checkIdentity(ctx, identity); err != nil {
		return nil, err
	}
	return d, nil
}
func (c *collector) terminate(ctx context.Context, params terminateParams) (*terminateDTO, error) {
	if params.Force == nil {
		return nil, fail("INVALID_REQUEST", "An explicit force choice is required")
	}
	identity := identityParams{params.PID, params.StartedAt}
	if identity.PID <= 0 || identity.StartedAt <= 0 {
		return nil, fail("INVALID_REQUEST", "A positive process ID and creation time are required")
	}
	if exists, err := process.PidExistsWithContext(ctx, identity.PID); err == nil && !exists {
		return &terminateDTO{Status: "already-exited", PID: identity.PID, StartedAt: identity.StartedAt}, nil
	}
	p, err := checkIdentity(ctx, identity)
	if err != nil {
		return nil, err
	}
	if start, ok := c.protected[p.Pid]; ok && (start == 0 || start == params.StartedAt) {
		return nil, fail("PROTECTED_PROCESS", "Collector and connection ancestors cannot be terminated")
	}
	if p.Pid <= 4 {
		return nil, fail("PROTECTED_PROCESS", "System processes cannot be terminated")
	}
	if err = terminatePlatform(ctx, p, identity, *params.Force); err != nil {
		return nil, err
	}
	result := &terminateDTO{Status: "pending", PID: p.Pid, StartedAt: identity.StartedAt}
	deadline := time.NewTimer(750 * time.Millisecond)
	defer deadline.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return result, nil
		case <-deadline.C:
			return result, nil
		case <-tick.C:
			// NewProcess avoids gopsutil's cached creation timestamp.
			current, e := process.NewProcessWithContext(ctx, p.Pid)
			if e != nil {
				exists, existErr := process.PidExistsWithContext(ctx, p.Pid)
				if existErr == nil && !exists {
					result.Status = "exited"
					return result, nil
				}
				continue
			}
			start, e := current.CreateTimeWithContext(ctx)
			if e == nil && start != identity.StartedAt {
				result.Status = "exited"
				return result, nil
			}
			if states, e := current.StatusWithContext(ctx); e == nil {
				for _, state := range states {
					if state == process.Zombie {
						result.Status = "exited"
						return result, nil
					}
				}
			}
		}
	}
}
