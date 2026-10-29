package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"unicode/utf8"
)

const maxCommandLine = 32768

type commandLineBuffer struct {
	data      []byte
	truncated bool
}

func (b *commandLineBuffer) Write(data []byte) (int, error) {
	remaining := maxCommandLine - len(b.data)
	if len(data) > remaining {
		b.truncated = true
		b.data = append(b.data, data[:remaining]...)
	} else {
		b.data = append(b.data, data...)
	}
	return len(data), nil
}

type commandLineDTO struct {
	PID         int32   `json:"pid"`
	StartedAt   int64   `json:"startedAt"`
	CommandLine *string `json:"commandLine"`
	Truncated   bool    `json:"truncated"`
	Unavailable string  `json:"unavailable,omitempty"`
}

func (c *collector) commandLine(ctx context.Context, identity identityParams) (*commandLineDTO, error) {
	p, err := checkIdentity(ctx, identity)
	if err != nil {
		return nil, err
	}
	value, truncated, readErr := platformCommandLine(ctx, p)
	if _, err = checkIdentity(ctx, identity); err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	result := &commandLineDTO{PID: identity.PID, StartedAt: identity.StartedAt}
	if readErr != nil {
		result.Unavailable = "unavailable"
		if errors.Is(readErr, os.ErrPermission) {
			result.Unavailable = "permission"
		}
		return result, nil
	}
	value = strings.ToValidUTF8(strings.ReplaceAll(value, "\x00", "�"), "�")
	if len(value) > maxCommandLine {
		value = value[:maxCommandLine]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
		truncated = true
	}
	result.CommandLine = &value
	result.Truncated = truncated
	return result, nil
}

// Quote each Unix argv item for readable boundaries; this is display text, never executed.
func displayArguments(args []string) string {
	var result strings.Builder
	for i, arg := range args {
		if i > 0 {
			result.WriteByte(' ')
		}
		if arg != "" && !strings.ContainsAny(arg, " \t\r\n'\"\\$`;&|<>()*?[]{}!#~") {
			result.WriteString(arg)
		} else {
			result.WriteByte('\'')
			result.WriteString(strings.ReplaceAll(arg, "'", "'\\''"))
			result.WriteByte('\'')
		}
		if result.Len() > maxCommandLine {
			break
		}
	}
	return result.String()
}
