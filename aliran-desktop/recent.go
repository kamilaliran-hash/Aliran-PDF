package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Files the app may read/write by path: command-line files plus recent files reopened from the menu.
var (
	files   []string
	filesMu sync.Mutex
)

func fileAt(i int) (string, bool) {
	filesMu.Lock()
	defer filesMu.Unlock()
	if i < 0 || i >= len(files) {
		return "", false
	}
	return files[i], true
}

func addFile(p string) int {
	filesMu.Lock()
	defer filesMu.Unlock()
	for i, f := range files {
		if f == p {
			return i
		}
	}
	files = append(files, p)
	return len(files) - 1
}

type recentEnt struct {
	Path string `json:"path"`
	Time int64  `json:"time"`
}

var recentMu sync.Mutex

func recentPath() string {
	dir, _ := os.UserCacheDir()
	if dir == "" {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "AliranPDF", "recent.json")
}

func loadRecent() []recentEnt {
	var l []recentEnt
	if b, err := os.ReadFile(recentPath()); err == nil {
		json.Unmarshal(b, &l)
	}
	return l
}

func touchRecent(p string) {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	recentMu.Lock()
	defer recentMu.Unlock()
	l := []recentEnt{{p, time.Now().UnixMilli()}}
	for _, e := range loadRecent() {
		if e.Path != p && len(l) < 15 {
			l = append(l, e)
		}
	}
	os.MkdirAll(filepath.Dir(recentPath()), 0755)
	if b, err := json.Marshal(l); err == nil {
		os.WriteFile(recentPath(), b, 0644)
	}
}

func registerRecentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/recent", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			recentMu.Lock()
			os.Remove(recentPath())
			recentMu.Unlock()
			writeJSON(w, map[string]any{"ok": true})
			return
		}
		out := []map[string]any{}
		recentMu.Lock()
		l := loadRecent()
		recentMu.Unlock()
		for i, e := range l {
			if st, err := os.Stat(e.Path); err == nil && !st.IsDir() {
				out = append(out, map[string]any{"i": i, "name": filepath.Base(e.Path), "path": e.Path, "time": e.Time})
			}
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("/api/recent/open", func(w http.ResponseWriter, r *http.Request) {
		i, _ := strconv.Atoi(r.URL.Query().Get("i"))
		recentMu.Lock()
		l := loadRecent()
		recentMu.Unlock()
		if i < 0 || i >= len(l) {
			writeJSON(w, map[string]string{"error": "That file is no longer in the recent list"})
			return
		}
		p := l[i].Path
		if _, err := os.Stat(p); err != nil {
			writeJSON(w, map[string]string{"error": filepath.Base(p) + " could not be found — it may have been moved or deleted"})
			return
		}
		touchRecent(p)
		writeJSON(w, map[string]any{"idx": addFile(p), "name": filepath.Base(p)})
	})
}
