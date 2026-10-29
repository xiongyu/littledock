package main

import (
	"context"
	"encoding/json"
	"github.com/shirou/gopsutil/v4/process"
	"os"
	"strings"
	"testing"
)

func TestCommandLineSelfAndIdentity(t *testing.T) {
	c := testCollector(t)
	p, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	created, err := p.CreateTime()
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.commandLine(context.Background(), identityParams{p.Pid, created})
	if err != nil {
		t.Fatal(err)
	}
	if result.CommandLine == nil || !strings.Contains(*result.CommandLine, "test") || len(*result.CommandLine) > maxCommandLine {
		t.Fatal("test process command line unavailable or invalid")
	}
	_, err = c.commandLine(context.Background(), identityParams{p.Pid, created + 1})
	assertCode(t, err, "IDENTITY_MISMATCH")
	// Never add command lines to snapshots or recording payloads.
	snapshot, err := c.snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(snapshot)
	if strings.Contains(string(data), `"commandLine"`) {
		t.Fatal("command line leaked into snapshot")
	}
}
func TestCommandLineBoundsAndArgumentDisplay(t *testing.T) {
	text := displayArguments([]string{"/test/app", "two words", "", "a'b", "--flag=中文"})
	if text != "/test/app 'two words' '' 'a'\\''b' --flag=中文" {
		t.Fatalf("argument boundaries lost: %q", text)
	}
	b := &commandLineBuffer{}
	payload := []byte(strings.Repeat("x", maxCommandLine+10))
	n, err := b.Write(payload)
	if err != nil || n != len(payload) || len(b.data) != maxCommandLine || !b.truncated {
		t.Fatal("output bound failed")
	}
	b.Write(payload)
	if len(b.data) != maxCommandLine {
		t.Fatal("output grew after limit")
	}
}
