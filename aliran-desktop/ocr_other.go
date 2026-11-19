//go:build !windows

package main

func backendInfo() ocrInfo                                  { return tessInfo() }
func backendRecognize(lang, path string) ([]ocrLine, error) { return tessRecognize(lang, path) }
