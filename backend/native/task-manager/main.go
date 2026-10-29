// WebNav collector is an on-demand, unprivileged stdio process. It never
// listens on a socket and never reads command lines or process environments.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	version          = "0.3.1"
	maxRequestBytes  = 256 * 1024
	maxResponseBytes = 2 * 1024 * 1024
	idleTimeout      = 30 * time.Second
)

type request struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type publicError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *publicError) Error() string { return e.Message }

type response struct {
	V      int          `json:"v"`
	ID     string       `json:"id"`
	OK     bool         `json:"ok"`
	Result any          `json:"result,omitempty"`
	Error  *publicError `json:"error,omitempty"`
}

func fail(code, message string) error { return &publicError{code, message} }
func decodeStrict(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return fail("INVALID_REQUEST", "Invalid request parameters")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fail("INVALID_REQUEST", "Expected exactly one JSON object")
	}
	return nil
}
func decodeParams(data []byte, target any) error {
	if len(data) == 0 {
		data = []byte("{}")
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fail("INVALID_REQUEST", "Parameters must be an object")
	}
	return decodeStrict(data, target)
}
func encodeResponse(id string, result any, err error) []byte {
	r := response{V: 1, ID: id, OK: err == nil, Result: result}
	if err != nil {
		r.Result = nil
		var public *publicError
		if errors.As(err, &public) {
			r.Error = public
		} else {
			r.Error = &publicError{"COLLECTION_FAILED", "The requested information is unavailable"}
		}
	}
	data, marshalErr := json.Marshal(r)
	if marshalErr != nil || len(data)+1 > maxResponseBytes {
		data, _ = json.Marshal(response{V: 1, ID: id, OK: false, Error: &publicError{"RESPONSE_TOO_LARGE", "Response exceeded the collection limit"}})
	}
	return append(data, '\n')
}

// The reader has a one-request buffer, so a sender cannot queue unbounded work.
// EOF cancels in-flight collection immediately; the parent also owns the process.
func serve(in io.Reader, out io.Writer, service *collector, timeout time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if closer, ok := in.(io.Closer); ok {
		defer closer.Close()
	}
	lines := make(chan []byte, 1)
	readErrors := make(chan error, 1)
	go func() {
		defer close(lines)
		defer cancel()
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 4096), maxRequestBytes+1)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			if len(line) > maxRequestBytes {
				readErrors <- fail("REQUEST_TOO_LARGE", "Request exceeded the collection limit")
				return
			}
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		if scanner.Err() != nil {
			readErrors <- fail("REQUEST_TOO_LARGE", "Request exceeded the collection limit")
		}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return
		case line, open := <-lines:
			if !open {
				select {
				case err := <-readErrors:
					_, _ = out.Write(encodeResponse("", nil, err))
				default:
				}
				return
			}
			if service.heartbeat != nil {
				service.heartbeat()
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(timeout)
			var req request
			err := decodeStrict(line, &req)
			if err == nil && (req.V != 1 || len(req.ID) == 0 || len(req.ID) > 128 || len(req.Method) > 32) {
				err = fail("INVALID_REQUEST", "Invalid protocol version, request ID or method")
			}
			var result any
			timedOut := false
			if err == nil {
				requestContext, requestCancel := context.WithTimeout(ctx, 15*time.Second)
				type operationResult struct {
					result any
					err    error
				}
				completed := make(chan operationResult, 1)
				go func() {
					value, operationErr := service.dispatch(requestContext, req)
					completed <- operationResult{value, operationErr}
				}()
				select {
				case operation := <-completed:
					result, err = operation.result, operation.err
				case <-requestContext.Done():
					err = fail("COLLECTION_TIMEOUT", "Collection was cancelled or exceeded its time limit")
					timedOut = true
				}
				requestCancel()
			}
			if _, writeErr := out.Write(encodeResponse(req.ID, result, err)); writeErr != nil {
				return
			}
			if timedOut {
				return
			}
			if err == nil && req.Method == "stop" {
				return
			}
		}
	}
}
func main() {
	defer closeGPU()
	if len(os.Args) == 2 && os.Args[1] == "--record" {
		runRecorderMode(false)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--record-recover" {
		runRecorderMode(true)
		return
	}
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	c, err := newCollector()
	if err != nil {
		_, _ = os.Stdout.Write(encodeResponse("", nil, err))
		os.Exit(1)
	}
	// A stalled parent can block stdout writes. An independent process watchdog
	// must still expire even while the protocol loop cannot make progress.
	exitCleanly := func() { closeGPU(); os.Exit(0) }
	watchdog := time.AfterFunc(idleTimeout, exitCleanly)
	defer watchdog.Stop()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() { <-signals; exitCleanly() }()
	c.heartbeat = func() { watchdog.Reset(idleTimeout) }
	serve(os.Stdin, os.Stdout, c, idleTimeout)
}
