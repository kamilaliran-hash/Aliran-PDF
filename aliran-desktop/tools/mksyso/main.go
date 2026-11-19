// Writes rsrc_windows_amd64.syso: a COFF object with an icon resource,
// which the Go linker embeds into the .exe.
package main

import (
	"bytes"
	"encoding/binary"
	"os"
)

type res struct {
	typ, id uint16
	data    []byte
}

func le(b *bytes.Buffer, v ...any) {
	for _, x := range v {
		binary.Write(b, binary.LittleEndian, x)
	}
}

func main() {
	sizes := []int{16, 24, 32, 48, 64, 128, 256}
	var items []res
	grp := &bytes.Buffer{}
	le(grp, uint16(0), uint16(1), uint16(len(sizes)))
	for i, s := range sizes {
		png, err := os.ReadFile("tools/icon" + itoa(s) + ".png")
		if err != nil {
			panic(err)
		}
		id := uint16(i + 1)
		items = append(items, res{3, id, png})
		w := byte(s)
		if s >= 256 {
			w = 0
		}
		le(grp, w, w, byte(0), byte(0), uint16(1), uint16(32), uint32(len(png)), id)
	}
	items = append(items, res{14, 1, grp.Bytes()})

	// Group by type (sorted: 3 then 14).
	types := []uint16{3, 14}
	byType := map[uint16][]res{}
	for _, r := range items {
		byType[r.typ] = append(byType[r.typ], r)
	}
	// Sizes: dir header 16, entry 8, data entry 16.
	rootSize := 16 + 8*len(types)
	off := rootSize
	typeDirOff := map[uint16]int{}
	for _, t := range types {
		typeDirOff[t] = off
		off += 16 + 8*len(byType[t])
	}
	nameDirOff := map[[2]uint16]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			nameDirOff[[2]uint16{t, r.id}] = off
			off += 16 + 8
		}
	}
	dataEntOff := map[[2]uint16]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			dataEntOff[[2]uint16{t, r.id}] = off
			off += 16
		}
	}
	dataOff := map[[2]uint16]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			off = (off + 7) &^ 7
			dataOff[[2]uint16{t, r.id}] = off
			off += len(r.data)
		}
	}
	total := (off + 7) &^ 7
	sec := make([]byte, total)
	w := func(at int, v ...any) {
		b := &bytes.Buffer{}
		le(b, v...)
		copy(sec[at:], b.Bytes())
	}
	dirHdr := func(at, n int) { w(at, uint32(0), uint32(0), uint16(0), uint16(0), uint16(0), uint16(n)) }
	dirHdr(0, len(types))
	for i, t := range types {
		w(16+8*i, uint32(t), uint32(typeDirOff[t])|0x80000000)
		dirHdr(typeDirOff[t], len(byType[t]))
		for j, r := range byType[t] {
			k := [2]uint16{t, r.id}
			w(typeDirOff[t]+16+8*j, uint32(r.id), uint32(nameDirOff[k])|0x80000000)
			dirHdr(nameDirOff[k], 1)
			w(nameDirOff[k]+16, uint32(0x0409), uint32(dataEntOff[k]))
			w(dataEntOff[k], uint32(dataOff[k]), uint32(len(r.data)), uint32(0), uint32(0))
			copy(sec[dataOff[k]:], r.data)
		}
	}
	// Relocations for each data entry's OffsetToData (RVA).
	var relocs []int
	for _, t := range types {
		for _, r := range byType[t] {
			relocs = append(relocs, dataEntOff[[2]uint16{t, r.id}])
		}
	}
	out := &bytes.Buffer{}
	ptrData := 20 + 40
	ptrRel := ptrData + len(sec)
	ptrSym := ptrRel + 10*len(relocs)
	le(out, uint16(0x8664), uint16(1), uint32(0), uint32(ptrSym), uint32(1), uint16(0), uint16(0))
	out.Write([]byte(".rsrc\x00\x00\x00"))
	le(out, uint32(0), uint32(0), uint32(len(sec)), uint32(ptrData), uint32(ptrRel), uint32(0), uint16(len(relocs)), uint16(0), uint32(0x40000040))
	out.Write(sec)
	for _, r := range relocs {
		le(out, uint32(r), uint32(0), uint16(3)) // IMAGE_REL_AMD64_ADDR32NB
	}
	out.Write([]byte(".rsrc\x00\x00\x00"))
	le(out, uint32(0), int16(1), uint16(0), byte(3), byte(0))
	le(out, uint32(4)) // empty string table
	if err := os.WriteFile("rsrc_windows_amd64.syso", out.Bytes(), 0644); err != nil {
		panic(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
