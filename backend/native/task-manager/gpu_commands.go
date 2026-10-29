package main

import (
	"errors"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

var errGPUCommandsClosed = errors.New("GPU command collection has stopped")

type gpuCommandEntry struct{ done chan struct{} }
type gpuCommandRegistry struct {
	init     sync.Once
	gate     chan struct{}
	closing  atomic.Bool
	commands map[*exec.Cmd]*gpuCommandEntry
}

var gpuCommands gpuCommandRegistry

func (r *gpuCommandRegistry) initialize() {
	r.init.Do(func() { r.gate = make(chan struct{}, 1); r.gate <- struct{}{} })
}

// Registration and Start share a gate. Shutdown marks closing immediately and
// waits only within its deadline if an OS process creation is already underway.
func (r *gpuCommandRegistry) run(command *exec.Cmd) error {
	r.initialize()
	finishProtection, err := protectGPUCommand(command)
	if err != nil {
		return err
	}
	defer finishProtection()
	<-r.gate
	if r.closing.Load() {
		r.gate <- struct{}{}
		return errGPUCommandsClosed
	}
	if err := command.Start(); err != nil {
		r.gate <- struct{}{}
		return err
	}
	entry := &gpuCommandEntry{done: make(chan struct{})}
	if r.commands == nil {
		r.commands = make(map[*exec.Cmd]*gpuCommandEntry)
	}
	r.commands[command] = entry
	if r.closing.Load() {
		// Close may have timed out behind Start. Reap the just-created tool as
		// soon as OS creation returns; parent-exit protection covers a crash.
		_ = command.Process.Kill()
	}
	r.gate <- struct{}{}
	err = command.Wait()
	<-r.gate
	delete(r.commands, command)
	close(entry.done)
	r.gate <- struct{}{}
	return err
}

func (r *gpuCommandRegistry) close() {
	r.initialize()
	r.closing.Store(true)
	deadline := time.NewTimer(500 * time.Millisecond)
	defer deadline.Stop()
	select {
	case <-r.gate:
	case <-deadline.C:
		return
	}
	commands := make(map[*exec.Cmd]*gpuCommandEntry, len(r.commands))
	for command, entry := range r.commands {
		commands[command] = entry
	}
	r.gate <- struct{}{}
	for command := range commands {
		// Kill is synchronous: main may return as soon as this method completes.
		// Only commands created by this registry are ever terminated.
		_ = command.Process.Kill()
	}
	for _, entry := range commands {
		select {
		case <-entry.done:
		case <-deadline.C:
			return
		}
	}
}

func runGPUCommand(command *exec.Cmd) error { return gpuCommands.run(command) }
func closeGPUCommands()                     { gpuCommands.close() }
