package main

// Installed fonts: list the TrueType/OpenType fonts on this computer and serve
// their files to the editor (for on-screen display and for embedding in PDFs).

import (
	"encoding/binary"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
)

type fontFace struct {
	ID         int    `json:"id"`
	Family     string `json:"family"`
	Style      string `json:"style"`
	Bold       bool   `json:"bold"`
	Italic     bool   `json:"italic"`
	PS         string `json:"ps"`
	Restricted bool   `json:"restricted"`
	CFF        bool   `json:"cff"`
	path       string
	off        uint32 // offset of this font's table directory (non-zero inside .ttc)
	ttc        bool
}

var (
	fontsOnce sync.Once
	fontList  []fontFace
)

func fontDirs() []string {
	if runtime.GOOS == "windows" {
		d := []string{filepath.Join(os.Getenv("WINDIR"), "Fonts")}
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			d = append(d, filepath.Join(la, "Microsoft", "Windows", "Fonts"))
		}
		return d
	}
	home, _ := os.UserHomeDir()
	return []string{"/usr/share/fonts", "/usr/local/share/fonts", filepath.Join(home, ".fonts"), filepath.Join(home, ".local/share/fonts"), "/Library/Fonts", "/System/Library/Fonts", filepath.Join(home, "Library/Fonts")}
}

func be16(b []byte) uint16 { return binary.BigEndian.Uint16(b) }
func be32(b []byte) uint32 { return binary.BigEndian.Uint32(b) }

func readAtN(f *os.File, off int64, n int) []byte {
	b := make([]byte, n)
	if k, _ := f.ReadAt(b, off); k < n {
		return nil
	}
	return b
}

type tableRec struct{ off, length uint32 }

func tableDir(f *os.File, off uint32) (map[string]tableRec, []byte) {
	h := readAtN(f, int64(off), 12)
	if h == nil {
		return nil, nil
	}
	n := int(be16(h[4:]))
	if n == 0 || n > 200 {
		return nil, nil
	}
	recs := readAtN(f, int64(off)+12, 16*n)
	if recs == nil {
		return nil, nil
	}
	m := map[string]tableRec{}
	for i := 0; i < n; i++ {
		r := recs[i*16:]
		m[string(r[0:4])] = tableRec{be32(r[8:]), be32(r[12:])}
	}
	return m, h[:4]
}

func decodeName(plat uint16, b []byte) string {
	if plat == 3 || plat == 0 {
		u := make([]uint16, len(b)/2)
		for i := range u {
			u[i] = be16(b[i*2:])
		}
		return string(utf16.Decode(u))
	}
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

func readNames(f *os.File, t tableRec) map[uint16]string {
	if t.length < 6 || t.length > 1<<20 {
		return nil
	}
	b := readAtN(f, int64(t.off), int(t.length))
	if b == nil {
		return nil
	}
	count, so := int(be16(b[2:])), int(be16(b[4:]))
	best := map[uint16]int{}
	out := map[uint16]string{}
	for i := 0; i < count && 6+i*12+12 <= len(b); i++ {
		r := b[6+i*12:]
		plat, enc, lang, id, ln, o := be16(r), be16(r[2:]), be16(r[4:]), be16(r[6:]), int(be16(r[8:])), int(be16(r[10:]))
		if id != 1 && id != 2 && id != 6 {
			continue
		}
		score := 0
		switch {
		case plat == 3 && (enc == 1 || enc == 10) && lang == 0x409:
			score = 4
		case plat == 3 && (enc == 1 || enc == 10):
			score = 3
		case plat == 0:
			score = 2
		case plat == 1 && lang == 0:
			score = 1
		default:
			continue
		}
		if score <= best[id] || so+o+ln > len(b) {
			continue
		}
		best[id] = score
		out[id] = strings.TrimSpace(decodeName(plat, b[so+o:so+o+ln]))
	}
	return out
}

func scanFont(path string, off uint32, ttc bool) (fontFace, bool) {
	f, err := os.Open(path)
	if err != nil {
		return fontFace{}, false
	}
	defer f.Close()
	tabs, ver := tableDir(f, off)
	if tabs == nil {
		return fontFace{}, false
	}
	_, hasGlyf := tabs["glyf"]
	_, hasCFF := tabs["CFF "]
	if (!hasGlyf && !hasCFF) || string(ver) == "true" {
		return fontFace{}, false
	}
	for _, need := range []string{"cmap", "head", "hhea", "hmtx", "maxp", "name"} {
		if _, ok := tabs[need]; !ok {
			return fontFace{}, false
		}
	}
	nm := readNames(f, tabs["name"])
	if nm[1] == "" || strings.HasPrefix(nm[1], ".") {
		return fontFace{}, false
	}
	ff := fontFace{Family: nm[1], Style: nm[2], PS: nm[6], CFF: hasCFF && !hasGlyf, path: path, off: off, ttc: ttc}
	if ff.Style == "" {
		ff.Style = "Regular"
	}
	sl := strings.ToLower(ff.Style)
	ff.Bold = strings.Contains(sl, "bold")
	ff.Italic = strings.Contains(sl, "italic") || strings.Contains(sl, "oblique")
	if t, ok := tabs["OS/2"]; ok && t.length >= 64 {
		if b := readAtN(f, int64(t.off), 64); b != nil {
			fsType := be16(b[8:])
			ff.Restricted = fsType&0x000F == 0x0002 || fsType&0x0200 != 0
			sel := be16(b[62:])
			ff.Italic = ff.Italic || sel&1 != 0
			ff.Bold = ff.Bold || sel&0x20 != 0
		}
	}
	return ff, true
}

func loadFonts() {
	seen := map[string]bool{}
	for _, dir := range fontDirs() {
		filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(p))
			if ext != ".ttf" && ext != ".otf" && ext != ".ttc" {
				return nil
			}
			if info, e := d.Info(); e != nil || info.Size() > 80<<20 {
				return nil
			}
			if ext == ".ttc" {
				f, e := os.Open(p)
				if e != nil {
					return nil
				}
				h := readAtN(f, 0, 12)
				if h != nil && string(h[:4]) == "ttcf" {
					n := int(be32(h[8:]))
					if n > 0 && n < 64 {
						if offs := readAtN(f, 12, 4*n); offs != nil {
							f.Close()
							for i := 0; i < n; i++ {
								if ff, ok := scanFont(p, be32(offs[i*4:]), true); ok {
									key := ff.Family + "|" + ff.Style
									if !seen[key] {
										seen[key] = true
										fontList = append(fontList, ff)
									}
								}
							}
							return nil
						}
					}
				}
				f.Close()
				return nil
			}
			if ff, ok := scanFont(p, 0, false); ok {
				key := ff.Family + "|" + ff.Style
				if !seen[key] {
					seen[key] = true
					fontList = append(fontList, ff)
				}
			}
			return nil
		})
	}
	sort.Slice(fontList, func(i, j int) bool {
		a, b := fontList[i], fontList[j]
		if !strings.EqualFold(a.Family, b.Family) {
			return strings.ToLower(a.Family) < strings.ToLower(b.Family)
		}
		return a.Style < b.Style
	})
	for i := range fontList {
		fontList[i].ID = i
	}
}

// extractFont returns a standalone font file (a single font is taken out of a .ttc collection).
func extractFont(ff fontFace) ([]byte, error) {
	data, err := os.ReadFile(ff.path)
	if err != nil || !ff.ttc {
		return data, err
	}
	off := int(ff.off)
	n := int(be16(data[off+4:]))
	type rec struct {
		tag             []byte
		cs, o, l, newOf uint32
	}
	recs := make([]rec, n)
	pos := uint32(12 + 16*n)
	for i := 0; i < n; i++ {
		r := data[off+12+i*16:]
		recs[i] = rec{r[0:4], be32(r[4:]), be32(r[8:]), be32(r[12:]), pos}
		pos += (be32(r[12:]) + 3) &^ 3
	}
	out := make([]byte, pos)
	copy(out[0:4], data[off:off+4])
	binary.BigEndian.PutUint16(out[4:], uint16(n))
	es := 0
	for (1 << (es + 1)) <= n {
		es++
	}
	binary.BigEndian.PutUint16(out[6:], uint16((1<<es)*16))
	binary.BigEndian.PutUint16(out[8:], uint16(es))
	binary.BigEndian.PutUint16(out[10:], uint16(n*16-(1<<es)*16))
	for i, r := range recs {
		w := out[12+i*16:]
		copy(w[0:4], r.tag)
		binary.BigEndian.PutUint32(w[4:], r.cs)
		binary.BigEndian.PutUint32(w[8:], r.newOf)
		binary.BigEndian.PutUint32(w[12:], r.l)
		if int(r.o+r.l) <= len(data) {
			copy(out[r.newOf:], data[r.o:r.o+r.l])
		}
	}
	return out, nil
}

func registerFontRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/fonts", func(w http.ResponseWriter, r *http.Request) {
		fontsOnce.Do(loadFonts)
		if fontList == nil {
			writeJSON(w, []fontFace{})
			return
		}
		writeJSON(w, fontList)
	})
	mux.HandleFunc("/api/font", func(w http.ResponseWriter, r *http.Request) {
		fontsOnce.Do(loadFonts)
		i, err := strconv.Atoi(r.URL.Query().Get("id"))
		if err != nil || i < 0 || i >= len(fontList) {
			http.NotFound(w, r)
			return
		}
		b, err := extractFont(fontList[i])
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "font/sfnt")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(b)
	})
}
