// Aliran PDF desktop launcher.
// Serves the bundled editor from memory on 127.0.0.1 and opens it in an
// app-style window (Microsoft Edge / Chrome), falling back to the default browser.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

var (
	mu        sync.Mutex
	lastPing  time.Time
	gotPing   bool
	startTime = time.Now()
)

func touch() {
	mu.Lock()
	lastPing = time.Now()
	gotPing = true
	mu.Unlock()
}

func main() {
	mime.AddExtensionType(".mjs", "text/javascript")
	mime.AddExtensionType(".wasm", "application/wasm")

	// Files passed on the command line ("Open with", drag onto the exe).
	var startFiles []string
	for _, a := range os.Args[1:] {
		if st, err := os.Stat(a); err == nil && !st.IsDir() {
			startFiles = append(startFiles, a)
		}
	}
	noBrowser := os.Getenv("ALIRAN_NO_BROWSER") != ""
	logf("start %v", os.Args[1:])
	if !noBrowser && handOff(startFiles) { // already running: that copy opens the window
		return
	}
	startIdx := []int{}
	for _, a := range startFiles {
		startIdx = append(startIdx, addFile(a))
		go touchRecent(a)
	}
	wins[0] = &winState{files: startIdx}

	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	static := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		touch()
		if id, err := strconv.Atoi(r.URL.Query().Get("w")); err == nil {
			winMu.Lock()
			if st := wins[id]; st != nil && st.token == r.URL.Query().Get("t") {
				st.seen = time.Now()
			}
			winMu.Unlock()
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/bye", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastPing = time.Now().Add(-55 * time.Second) // exit soon unless the page pings again (e.g. a reload)
		mu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/ocr/info", ocrInfoHandler)
	registerPrintRoutes(mux)
	registerRecentRoutes(mux)
	registerFontRoutes(mux)
	go fontsOnce.Do(loadFonts) // scan installed fonts in the background
	registerWindowRoutes(mux)
	mux.HandleFunc("/api/newwindow", func(w http.ResponseWriter, r *http.Request) {
		go launchWindow(newWindow(nil))
		writeJSON(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/exit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(400 * time.Millisecond); quit(0) }()
	})
	mux.HandleFunc("/api/ocr", ocrHandler)
	mux.HandleFunc("/api/args", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(r.URL.Query().Get("w"))
		list := []map[string]any{}
		for _, i := range windowFiles(id) {
			if p, ok := fileAt(i); ok {
				list = append(list, map[string]any{"name": filepath.Base(p), "i": i})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/api/save", func(w http.ResponseWriter, r *http.Request) {
		i, err := strconv.Atoi(r.URL.Query().Get("i"))
		path, ok := fileAt(i)
		if r.Method != http.MethodPost || err != nil || !ok {
			writeJSON(w, map[string]string{"error": "no file to save to"})
			return
		}
		if err := saveOver(path, r.Body); err != nil {
			writeJSON(w, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/file", func(w http.ResponseWriter, r *http.Request) {
		i, err := strconv.Atoi(r.URL.Query().Get("i"))
		path, ok := fileAt(i)
		if err != nil || !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, path)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail("Aliran PDF could not start: " + err.Error())
		return
	}
	url := "http://" + ln.Addr().String() + "/index.html"
	baseURL = url
	if !noBrowser {
		writeInstance(ln.Addr().String())
		go launchWindow(0)
	} else {
		println(url)
	}
	go watchdog()
	http.Serve(ln, mux)
}

// Exit when the window has been closed (no heartbeat from the page).
func watchdog() {
	for {
		time.Sleep(2 * time.Second)
		mu.Lock()
		g, lp := gotPing, lastPing
		mu.Unlock()
		if !g && time.Since(startTime) > 3*time.Minute {
			logf("no window ever connected - exiting")
			quit(0)
		}
		if g && time.Since(lp) > 60*time.Second {
			quit(0)
		}
	}
}

func openWindow(url string) {
	app := []string{"--app=" + url, "--window-size=1400,900", "--no-first-run", "--no-default-browser-check"}
	if runtime.GOOS == "windows" {
		if dir, err := os.UserCacheDir(); err == nil { // %LOCALAPPDATA%
			app = append(app, "--user-data-dir="+filepath.Join(dir, "AliranPDF", "browser"))
		}
		pf := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")}
		cands := []string{}
		for _, base := range pf {
			if base == "" {
				continue
			}
			cands = append(cands,
				filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
		}
		for _, c := range cands {
			if _, err := os.Stat(c); err == nil {
				// Do NOT start the browser hidden: after a restart Edge starts a fresh process whose
				// first window takes the start-up show state, so a hidden start gives an invisible window.
				cmd := exec.Command(c, app...)
				if err := cmd.Start(); err == nil {
					logf("started %s", filepath.Base(c))
					go cmd.Wait()
					return
				} else {
					logf("could not start %s: %v", c, err)
				}
			}
		}
		openDefault(url)
		return
	}
	for _, b := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(b); err == nil {
			if exec.Command(p, app...).Start() == nil {
				return
			}
		}
	}
	openDefault(url)
}

func openDefault(url string) {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		hide(cmd)
		cmd.Start()
	case "darwin":
		exec.Command("open", url).Start()
	default:
		exec.Command("xdg-open", url).Start()
	}
}

// saveOver safely replaces path: write a temp file next to it, then rename over the original.
func saveOver(path string, body io.Reader) error {
	dir := filepath.Dir(path)
	if st, err := os.Stat(path); err == nil && st.Mode().Perm()&0200 == 0 {
		return fmt.Errorf("%s is read-only", filepath.Base(path))
	}
	tmp, err := os.CreateTemp(dir, ".aliran-save-*.tmp")
	if err != nil {
		return fmt.Errorf("cannot write in %s: %v", dir, err)
	}
	tn := tmp.Name()
	_, err = io.Copy(tmp, io.LimitReader(body, 2<<30))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tn)
		return err
	}
	var rerr error
	for i := 0; i < 5; i++ { // retry briefly (antivirus / indexer may hold the file)
		if rerr = os.Rename(tn, path); rerr == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	os.Remove(tn)
	return fmt.Errorf("%s is in use by another program (e.g. Adobe Reader) — close it there and try again: %v", filepath.Base(path), rerr)
}
