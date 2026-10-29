package main

import "os/exec"

// macOS has no Linux parent-death signal. Normal shutdown synchronously kills
// registered tools; each platform query also keeps its own short deadline.
func protectGPUCommand(_ *exec.Cmd) (func(), error) { return func() {}, nil }
