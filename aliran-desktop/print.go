package main

import (
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
)

type printerInfo struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
}

type paperInfo struct {
	ID   int     `json:"id"`
	Name string  `json:"name"`
	W    float64 `json:"w"` // points, portrait
	H    float64 `json:"h"`
}

type binInfo struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type curSettings struct {
	Orient  int `json:"orient"` // 1 portrait, 2 landscape
	Copies  int `json:"copies"`
	Color   int `json:"color"`   // 1 mono, 2 color
	Duplex  int `json:"duplex"`  // 1 simplex, 2 long edge, 3 short edge
	Collate int `json:"collate"` // 0/1
}

type printerCaps struct {
	Name   string      `json:"name"`
	DPI    int         `json:"dpi"`
	Paper  paperInfo   `json:"paper"`  // current paper (portrait, points)
	Margin float64     `json:"margin"` // unprintable margin (points)
	Papers []paperInfo `json:"papers"`
	Bins   []binInfo   `json:"bins"`
	Bin    int         `json:"bin"`
	Color  bool        `json:"color"`
	Duplex bool        `json:"duplex"`
	Cur    curSettings `json:"cur"`
}

type beginReq struct {
	Printer string `json:"printer"`
	DocName string `json:"docName"`
	Copies  int    `json:"copies"`
	Collate bool   `json:"collate"`
	Duplex  int    `json:"duplex"`
	Color   int    `json:"color"`
	Orient  int    `json:"orient"`
}

func jerr(w http.ResponseWriter, err error) { writeJSON(w, map[string]string{"error": err.Error()}) }

func registerPrintRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/printers", func(w http.ResponseWriter, r *http.Request) {
		list, def, err := prList()
		if err != nil {
			jerr(w, err)
			return
		}
		if list == nil {
			list = []printerInfo{}
		}
		writeJSON(w, map[string]any{"printers": list, "default": def})
	})
	mux.HandleFunc("/api/printer/caps", func(w http.ResponseWriter, r *http.Request) {
		c, err := prCaps(r.URL.Query().Get("name"))
		if err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, c)
	})
	mux.HandleFunc("/api/printer/properties", func(w http.ResponseWriter, r *http.Request) {
		ok, c, err := prProperties(r.URL.Query().Get("name"))
		if err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": ok, "caps": c})
	})
	mux.HandleFunc("/api/printer/set", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Paper int `json:"paper"`
			Bin   int `json:"bin"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		c, err := prSet(r.URL.Query().Get("name"), req.Paper, req.Bin)
		if err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, c)
	})
	mux.HandleFunc("/api/print/begin", func(w http.ResponseWriter, r *http.Request) {
		var req beginReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jerr(w, err)
			return
		}
		if req.Copies < 1 {
			req.Copies = 1
		}
		id, err := prBegin(req)
		if err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, map[string]any{"job": id})
	})
	mux.HandleFunc("/api/print/page", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		orient, _ := strconv.Atoi(q.Get("orient"))
		paper, _ := strconv.Atoi(q.Get("paper"))
		img, _, err := image.Decode(io.LimitReader(r.Body, 500<<20))
		if err != nil {
			jerr(w, err)
			return
		}
		if err := prPage(q.Get("job"), orient, paper, img); err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/print/end", func(w http.ResponseWriter, r *http.Request) {
		info, err := prEnd(r.URL.Query().Get("job"))
		if err != nil {
			jerr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "info": info})
	})
	mux.HandleFunc("/api/print/abort", func(w http.ResponseWriter, r *http.Request) {
		prAbort(r.URL.Query().Get("job"))
		writeJSON(w, map[string]any{"ok": true})
	})
}

// rgbAt returns 8-bit RGB for a pixel, with fast paths for the common types.
func rowRGB(img image.Image, y int, out []byte, bgr bool) {
	b := img.Bounds()
	W := b.Dx()
	put := func(x int, r, g, bl uint8) {
		if bgr {
			out[x*3], out[x*3+1], out[x*3+2] = bl, g, r
		} else {
			out[x*3], out[x*3+1], out[x*3+2] = r, g, bl
		}
	}
	switch m := img.(type) {
	case *image.NRGBA:
		row := m.Pix[(y)*m.Stride:]
		for x := 0; x < W; x++ {
			a := uint32(row[x*4+3])
			if a == 255 {
				put(x, row[x*4], row[x*4+1], row[x*4+2])
			} else { // blend on white
				f := func(c uint8) uint8 { return uint8((uint32(c)*a + 255*(255-a)) / 255) }
				put(x, f(row[x*4]), f(row[x*4+1]), f(row[x*4+2]))
			}
		}
	case *image.RGBA:
		row := m.Pix[(y)*m.Stride:]
		for x := 0; x < W; x++ {
			a := uint32(row[x*4+3])
			f := func(c uint8) uint8 { return uint8(uint32(c) + 255 - a) }
			put(x, f(row[x*4]), f(row[x*4+1]), f(row[x*4+2]))
		}
	default:
		for x := 0; x < W; x++ {
			r, g, bl, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			w := 0xffff - a
			put(x, uint8((r+w)>>8), uint8((g+w)>>8), uint8((bl+w)>>8))
		}
	}
}
