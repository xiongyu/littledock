//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func recorderTryLock(path string) (func(), error) {
	if err := recorderCheckLockPath(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err != nil {
		file.Close()
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return nil, os.ErrExist
		}
		return nil, err
	}
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
}
func recorderSecureDirectory(path string) error { return os.Chmod(path, 0700) }
func recorderDetach(command *exec.Cmd) {
	// A fresh session, null stdio and no Pdeathsig detach from the SSH channel.
	// Host login/session policies may still stop the process; status reports it.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func recorderReplaceMetadata(temporary, path string) error {
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
