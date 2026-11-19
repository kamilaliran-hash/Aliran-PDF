//go:build !windows

package main

import "os/exec"

func hide(c *exec.Cmd) {}
func fail(msg string)  { println(msg) }
