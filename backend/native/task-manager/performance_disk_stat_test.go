package main

import (
	"testing"
	"time"
)

func TestLinuxDiskStatParsing(t *testing.T) {
	row, valid := linuxDiskCounter("nvme0n1", "20 0 100 15 30 0 200 25 0 40 80", time.Now())
	if !valid || row.ReadBytes != 51200 || row.WriteBytes != 102400 || row.BusyMillis == nil || *row.BusyMillis != 40 {
		t.Fatal("wrong Linux diskstat field units")
	}
	for _, invalid := range []string{"", "20 0 100", "20 0 invalid 15 30 0 200 25 0 40 80", "20 0 18446744073709551615 15 30 0 200 25 0 40 80"} {
		if _, valid = linuxDiskCounter("disk", invalid, time.Now()); valid {
			t.Fatal("invalid disk statistics accepted")
		}
	}
}
