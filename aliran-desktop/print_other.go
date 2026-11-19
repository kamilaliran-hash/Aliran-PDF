//go:build !windows

package main

// Non-Windows printing: CUPS printers via lp, plus a test printer that saves
// each printed sheet as a PNG (used for automated testing).

import (
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const testPrinter = "Aliran Test Printer (saves images)"

var stdPapers = []paperInfo{
	{9, "A4", 595.28, 841.89}, {8, "A3", 841.89, 1190.55}, {11, "A5", 419.53, 595.28},
	{1, "Letter", 612, 792}, {5, "Legal", 612, 1008}, {3, "Tabloid", 792, 1224},
}

var (
	omu     sync.Mutex
	oSet    = map[string][2]int{} // printer -> paper, bin
	oJobs   = map[string]*oJob{}
	oJobSeq = 0
)

type oJob struct {
	req   beginReq
	dir   string
	files []string
}

func prList() ([]printerInfo, string, error) {
	list := []printerInfo{{Name: testPrinter, Default: true}}
	if out, err := exec.Command("lpstat", "-e").Output(); err == nil {
		for _, l := range strings.Split(string(out), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				list = append(list, printerInfo{Name: l})
			}
		}
	}
	return list, testPrinter, nil
}

func prCaps(name string) (*printerCaps, error) {
	omu.Lock()
	s, ok := oSet[name]
	omu.Unlock()
	if !ok {
		s = [2]int{9, 7}
	}
	p := stdPapers[0]
	for _, q := range stdPapers {
		if q.ID == s[0] {
			p = q
		}
	}
	return &printerCaps{Name: name, DPI: 300, Paper: p, Margin: 12, Papers: stdPapers,
		Bins: []binInfo{{7, "Automatically Select"}, {1, "Tray 1"}, {2, "Tray 2"}, {4, "Bypass Tray"}}, Bin: s[1],
		Color: true, Duplex: true, Cur: curSettings{Orient: 1, Copies: 1, Color: 2, Duplex: 1, Collate: 1}}, nil
}

func prProperties(name string) (bool, *printerCaps, error) {
	c, err := prCaps(name)
	return false, c, err
}

func prSet(name string, paper, bin int) (*printerCaps, error) {
	omu.Lock()
	s, ok := oSet[name]
	if !ok {
		s = [2]int{9, 7}
	}
	if paper > 0 {
		s[0] = paper
	}
	if bin > 0 {
		s[1] = bin
	}
	oSet[name] = s
	omu.Unlock()
	return prCaps(name)
}

func prBegin(req beginReq) (string, error) {
	dir, err := os.MkdirTemp("", "aliran-print-")
	if err != nil {
		return "", err
	}
	omu.Lock()
	defer omu.Unlock()
	oJobSeq++
	id := strconv.Itoa(oJobSeq)
	oJobs[id] = &oJob{req: req, dir: dir}
	return id, nil
}

func prPage(id string, orient, paper int, img image.Image) error {
	omu.Lock()
	j := oJobs[id]
	omu.Unlock()
	if j == nil {
		return errors.New("print job not found")
	}
	fn := filepath.Join(j.dir, fmt.Sprintf("sheet%03d_o%d_p%d.png", len(j.files)+1, orient, paper))
	f, err := os.Create(fn)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return err
	}
	j.files = append(j.files, fn)
	return nil
}

func prEnd(id string) (string, error) {
	omu.Lock()
	j := oJobs[id]
	delete(oJobs, id)
	omu.Unlock()
	if j == nil {
		return "", errors.New("print job not found")
	}
	if j.req.Printer == testPrinter {
		return fmt.Sprintf("%d sheet(s) saved in %s (copies=%d duplex=%d color=%d)", len(j.files), j.dir, j.req.Copies, j.req.Duplex, j.req.Color), nil
	}
	args := []string{"-d", j.req.Printer, "-n", strconv.Itoa(j.req.Copies), "-o", "fit-to-page"}
	switch j.req.Duplex {
	case 2:
		args = append(args, "-o", "sides=two-sided-long-edge")
	case 3:
		args = append(args, "-o", "sides=two-sided-short-edge")
	}
	args = append(args, j.files...)
	if out, err := exec.Command("lp", args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("lp: %s", strings.TrimSpace(string(out)))
	}
	return fmt.Sprintf("%d sheet(s) sent to %s", len(j.files), j.req.Printer), nil
}

func prAbort(id string) {
	omu.Lock()
	delete(oJobs, id)
	omu.Unlock()
}
