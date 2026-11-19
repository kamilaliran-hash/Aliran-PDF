package main

// Reliable start-up:
//   - one Aliran PDF process serves all windows: a second launch hands its files to the running one;
//   - every window has an id; only one browser tab may own an id, so a relaunched window never duplicates;
//   - if the window has not shown up a few seconds after launch (cold start after a reboot, browser
//     busy updating, …) the launcher opens it again, then falls back to the default browser.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type winState struct {
	files []int
	token string // the browser tab that owns this window
	seen  time.Time
}

var (
	winMu   sync.Mutex
	wins    = map[int]*winState{}
	nextWin = 1
	baseURL string
	instKey string
	logMu   sync.Mutex
)

func appDir() string {
	dir, _ := os.UserCacheDir()
	if dir == "" {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "AliranPDF")
}

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	p := filepath.Join(appDir(), "launch.log")
	os.MkdirAll(appDir(), 0755)
	if st, err := os.Stat(p); err == nil && st.Size() > 128<<10 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%d] %s\n", time.Now().Format("2006-01-02 15:04:05.000"), os.Getpid(), fmt.Sprintf(format, a...))
}

func newWindow(fileIdx []int) int {
	winMu.Lock()
	defer winMu.Unlock()
	id := nextWin
	nextWin++
	wins[id] = &winState{files: fileIdx}
	return id
}

func windowURL(id int) string { return baseURL + "?w=" + strconv.Itoa(id) }

func windowSeen(id int) bool {
	winMu.Lock()
	defer winMu.Unlock()
	w := wins[id]
	return w != nil && w.token != ""
}

// launchWindow opens window id and keeps trying until the page actually connects.
func launchWindow(id int) {
	logf("open window %d", id)
	openWindow(windowURL(id))
	for i, wait := range []time.Duration{12 * time.Second, 15 * time.Second} {
		dl := time.Now().Add(wait)
		for time.Now().Before(dl) {
			if windowSeen(id) {
				logf("window %d connected", id)
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		if i == 0 {
			logf("window %d did not appear after %v - opening it again", id, wait)
			openWindow(windowURL(id))
		} else {
			logf("window %d still missing - using the default browser", id)
			openDefault(windowURL(id))
		}
	}
}

func instanceFile() string { return filepath.Join(appDir(), "instance.json") }

type instInfo struct {
	Addr string `json:"addr"`
	Key  string `json:"key"`
	Pid  int    `json:"pid"`
}

// handOff passes the files to an Aliran PDF that is already running. True when it took them.
func handOff(paths []string) bool {
	b, err := os.ReadFile(instanceFile())
	if err != nil {
		return false
	}
	var in instInfo
	if json.Unmarshal(b, &in) != nil || in.Addr == "" {
		return false
	}
	abs := []string{}
	for _, p := range paths {
		if a, err := filepath.Abs(p); err == nil {
			abs = append(abs, a)
		}
	}
	body, _ := json.Marshal(map[string]any{"key": in.Key, "files": abs})
	cl := &http.Client{Timeout: 2 * time.Second}
	r, err := cl.Post("http://"+in.Addr+"/api/handoff", "application/json", bytes.NewReader(body))
	if err != nil {
		logf("no running instance at %s (%v)", in.Addr, err)
		return false
	}
	defer r.Body.Close()
	var res map[string]any
	json.NewDecoder(r.Body).Decode(&res)
	ok := r.StatusCode == 200 && res["ok"] == true
	logf("hand-off to running instance %s: %v", in.Addr, ok)
	return ok
}

func writeInstance(addr string) {
	k := make([]byte, 16)
	rand.Read(k)
	instKey = hex.EncodeToString(k)
	b, _ := json.Marshal(instInfo{Addr: addr, Key: instKey, Pid: os.Getpid()})
	os.MkdirAll(appDir(), 0755)
	os.WriteFile(instanceFile(), b, 0600)
}

func removeInstance() {
	b, err := os.ReadFile(instanceFile())
	if err == nil && strings.Contains(string(b), instKey) && instKey != "" {
		os.Remove(instanceFile())
	}
}

func quit(code int) {
	removeInstance()
	os.Exit(code)
}

func registerWindowRoutes(mux *http.ServeMux) {
	// The page says hello with its tab token; a second tab for the same window is told to close.
	mux.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) {
		touch()
		id, _ := strconv.Atoi(r.URL.Query().Get("w"))
		tok := r.URL.Query().Get("t")
		winMu.Lock()
		st := wins[id]
		if st == nil {
			st = &winState{}
			wins[id] = st
		}
		dup := tok != "" && st.token != "" && st.token != tok && time.Since(st.seen) < 20*time.Second
		if !dup && tok != "" {
			st.token = tok
		}
		st.seen = time.Now()
		winMu.Unlock()
		if dup {
			logf("window %d opened twice - closing the extra copy", id)
		}
		writeJSON(w, map[string]any{"close": dup})
	})
	mux.HandleFunc("/api/handoff", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Key   string   `json:"key"`
			Files []string `json:"files"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&req) != nil || req.Key != instKey {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		idx := []int{}
		for _, p := range req.Files {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				idx = append(idx, addFile(p))
				go touchRecent(p)
			}
		}
		// Initial window still starting with exactly these files? Bring that one up instead of a second copy.
		target := -1
		winMu.Lock()
		if st := wins[0]; st != nil && st.token == "" && equalInts(st.files, idx) {
			target = 0
		}
		winMu.Unlock()
		if target < 0 {
			target = newWindow(idx)
		}
		go launchWindow(target)
		writeJSON(w, map[string]any{"ok": true})
	})
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func windowFiles(id int) []int {
	winMu.Lock()
	defer winMu.Unlock()
	if st := wins[id]; st != nil {
		return append([]int(nil), st.files...)
	}
	return nil
}
