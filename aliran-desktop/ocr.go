package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type ocrLang struct {
	Tag  string `json:"tag"`
	Name string `json:"name"`
}

type ocrInfo struct {
	Available bool      `json:"available"`
	Engine    string    `json:"engine"`
	Langs     []ocrLang `json:"langs"`
	Default   string    `json:"default"`
	MaxDim    int       `json:"maxDim"`
	Error     string    `json:"error,omitempty"`
}

type ocrLine struct {
	Text string  `json:"text"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func ocrInfoHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, backendInfo())
}

func ocrHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	lang := r.URL.Query().Get("lang")
	f, err := os.CreateTemp("", "aliran-ocr-*.png")
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	path := f.Name()
	defer os.Remove(path)
	_, err = io.Copy(f, io.LimitReader(r.Body, 200<<20))
	f.Close()
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	abs, _ := filepath.Abs(path)
	lines, err := backendRecognize(lang, abs)
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	if lines == nil {
		lines = []ocrLine{}
	}
	writeJSON(w, map[string]any{"lines": lines})
}

/* ---------- Tesseract (used on Linux/macOS, and on Windows as a fallback if installed) ---------- */

var tessNames = map[string]string{
	"eng": "English", "ind": "Indonesian / Malay", "msa": "Malay", "chi_sim": "Chinese (Simplified)", "chi_tra": "Chinese (Traditional)",
	"tam": "Tamil", "ara": "Arabic", "jpn": "Japanese", "kor": "Korean", "fra": "French", "deu": "German", "spa": "Spanish",
	"ita": "Italian", "por": "Portuguese", "nld": "Dutch", "rus": "Russian", "tha": "Thai", "vie": "Vietnamese", "hin": "Hindi",
	"tur": "Turkish", "pol": "Polish", "heb": "Hebrew",
}

func tessPath() string {
	if p, err := exec.LookPath("tesseract"); err == nil {
		return p
	}
	for _, c := range []string{`C:\Program Files\Tesseract-OCR\tesseract.exe`, `C:\Program Files (x86)\Tesseract-OCR\tesseract.exe`} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func tessInfo() ocrInfo {
	tp := tessPath()
	if tp == "" {
		return ocrInfo{Available: false, Error: "No OCR engine found"}
	}
	cmd := exec.Command(tp, "--list-langs")
	hide(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ocrInfo{Available: false, Error: "tesseract: " + err.Error()}
	}
	info := ocrInfo{Available: true, Engine: "tesseract", MaxDim: 10000}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.Contains(t, " ") || t == "osd" || t == "equ" {
			continue
		}
		name := tessNames[t]
		if name == "" {
			name = t
		}
		info.Langs = append(info.Langs, ocrLang{t, name})
	}
	sort.Slice(info.Langs, func(i, j int) bool { return info.Langs[i].Name < info.Langs[j].Name })
	for _, l := range info.Langs {
		if l.Tag == "eng" {
			info.Default = "eng"
		}
	}
	if info.Default == "" && len(info.Langs) > 0 {
		info.Default = info.Langs[0].Tag
	}
	if len(info.Langs) == 0 {
		return ocrInfo{Available: false, Error: "Tesseract has no language data installed"}
	}
	return info
}

func tessRecognize(lang, path string) ([]ocrLine, error) {
	tp := tessPath()
	if tp == "" {
		return nil, errors.New("no OCR engine found")
	}
	if lang == "" {
		lang = "eng"
	}
	cmd := exec.Command(tp, path, "stdout", "-l", lang, "--psm", "3", "tsv")
	hide(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New("tesseract failed: " + strings.TrimSpace(stderr.String()))
	}
	type acc struct {
		words          []string
		x0, y0, x1, y1 float64
		order          int
	}
	groups := map[string]*acc{}
	n := 0
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) < 12 || f[0] != "5" {
			continue
		}
		txt := strings.TrimSpace(f[11])
		conf, _ := strconv.ParseFloat(f[10], 64)
		if txt == "" || conf < 0 {
			continue
		}
		l, _ := strconv.ParseFloat(f[6], 64)
		t, _ := strconv.ParseFloat(f[7], 64)
		w, _ := strconv.ParseFloat(f[8], 64)
		h, _ := strconv.ParseFloat(f[9], 64)
		key := f[1] + "/" + f[2] + "/" + f[3] + "/" + f[4]
		g := groups[key]
		if g == nil {
			g = &acc{x0: l, y0: t, x1: l + w, y1: t + h, order: n}
			n++
			groups[key] = g
		}
		g.words = append(g.words, txt)
		if l < g.x0 {
			g.x0 = l
		}
		if t < g.y0 {
			g.y0 = t
		}
		if l+w > g.x1 {
			g.x1 = l + w
		}
		if t+h > g.y1 {
			g.y1 = t + h
		}
	}
	list := make([]*acc, 0, len(groups))
	for _, g := range groups {
		list = append(list, g)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].order < list[j].order })
	lines := []ocrLine{}
	for _, g := range list {
		lines = append(lines, ocrLine{strings.Join(g.words, " "), g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0})
	}
	return lines, nil
}
