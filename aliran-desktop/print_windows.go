package main

// Native Windows printing: real printer list, the driver's own
// "Printing Preferences" dialog, paper sizes/trays, and GDI print jobs
// that honour copies, collation, duplex, colour, orientation and paper.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	modWinspool             = syscall.NewLazyDLL("winspool.drv")
	procEnumPrinters        = modWinspool.NewProc("EnumPrintersW")
	procGetDefaultPrinter   = modWinspool.NewProc("GetDefaultPrinterW")
	procOpenPrinter         = modWinspool.NewProc("OpenPrinterW")
	procClosePrinter        = modWinspool.NewProc("ClosePrinter")
	procDocumentProperties  = modWinspool.NewProc("DocumentPropertiesW")
	procDeviceCapabilities  = modWinspool.NewProc("DeviceCapabilitiesW")
	modGdi                  = syscall.NewLazyDLL("gdi32.dll")
	procCreateDC            = modGdi.NewProc("CreateDCW")
	procDeleteDC            = modGdi.NewProc("DeleteDC")
	procStartDoc            = modGdi.NewProc("StartDocW")
	procEndDoc              = modGdi.NewProc("EndDoc")
	procAbortDoc            = modGdi.NewProc("AbortDoc")
	procStartPage           = modGdi.NewProc("StartPage")
	procEndPage             = modGdi.NewProc("EndPage")
	procResetDC             = modGdi.NewProc("ResetDCW")
	procGetDeviceCaps       = modGdi.NewProc("GetDeviceCaps")
	procStretchDIBits       = modGdi.NewProc("StretchDIBits")
	procSetStretchBltMode   = modGdi.NewProc("SetStretchBltMode")
	procSetBrushOrgEx       = modGdi.NewProc("SetBrushOrgEx")
	procGetForegroundWindow = syscall.NewLazyDLL("user32.dll").NewProc("GetForegroundWindow")
	procCoInitializeEx      = syscall.NewLazyDLL("ole32.dll").NewProc("CoInitializeEx")
)

const (
	dmOutBuffer = 2
	dmInPrompt  = 4
	dmInBuffer  = 8

	dmFOrientation = 0x1
	dmFPaperSize   = 0x2
	dmFCopies      = 0x100
	dmFSource      = 0x200
	dmFColor       = 0x800
	dmFDuplex      = 0x1000
	dmFCollate     = 0x8000

	// DEVMODEW byte offsets
	offFields  = 72
	offOrient  = 76
	offPaper   = 78
	offCopies  = 86
	offSource  = 88
	offColor   = 92
	offDuplex  = 94
	offCollate = 100
)

/* ---------- a dedicated OS thread for all printing / driver UI ---------- */

var prCh = make(chan func())

func init() {
	go func() {
		runtime.LockOSThread()
		procCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED (some drivers need COM)
		for f := range prCh {
			f()
		}
	}()
}

func onPT(f func() error) (err error) {
	done := make(chan struct{})
	prCh <- func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("printing error: %v", r)
			}
		}()
		err = f()
	}
	<-done
	return
}

/* ---------- helpers ---------- */

func wstr(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func wstrPtr(p *uint16) string {
	if p == nil {
		return ""
	}
	var u []uint16
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Add(ptr, 2) {
		c := *(*uint16)(ptr)
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return syscall.UTF16ToString(u)
}

func get16(b []byte, off int) int    { return int(int16(binary.LittleEndian.Uint16(b[off:]))) }
func set16(b []byte, off int, v int) { binary.LittleEndian.PutUint16(b[off:], uint16(int16(v))) }

func openPrinter(name string) (uintptr, error) {
	var h uintptr
	r, _, e := procOpenPrinter.Call(uintptr(unsafe.Pointer(wstr(name))), uintptr(unsafe.Pointer(&h)), 0)
	if r == 0 {
		return 0, fmt.Errorf("could not open printer %q: %v", name, e)
	}
	return h, nil
}

type printerInfo4 struct {
	PrinterName *uint16
	ServerName  *uint16
	Attributes  uint32
}

type docInfo struct {
	Size     int32
	DocName  *uint16
	Output   *uint16
	Datatype *uint16
	Type     uint32
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

/* ---------- printer settings (DEVMODE) ---------- */

var dmStore = map[string][]byte{} // per-printer settings for this session (print thread only)

func baseDevmode(name string) ([]byte, error) {
	if dm, ok := dmStore[name]; ok {
		return dm, nil
	}
	h, err := openPrinter(name)
	if err != nil {
		return nil, err
	}
	defer procClosePrinter.Call(h)
	np := uintptr(unsafe.Pointer(wstr(name)))
	n, _, _ := procDocumentProperties.Call(0, h, np, 0, 0, 0)
	if int32(n) <= 0 {
		return nil, errors.New("could not read the printer's settings")
	}
	dm := make([]byte, n)
	r, _, _ := procDocumentProperties.Call(0, h, np, uintptr(unsafe.Pointer(&dm[0])), 0, dmOutBuffer)
	if int32(r) < 0 {
		return nil, errors.New("could not read the printer's settings")
	}
	dmStore[name] = dm
	return dm, nil
}

type dmOv struct {
	Orient, Paper, Copies, Source, Color, Duplex int
	Collate                                      *bool
}

// applyDM returns a copy of dm with the overrides applied and validated by the driver.
func applyDM(name string, dm []byte, o dmOv) []byte {
	c := append([]byte(nil), dm...)
	f := binary.LittleEndian.Uint32(c[offFields:])
	if o.Orient > 0 {
		set16(c, offOrient, o.Orient)
		f |= dmFOrientation
	}
	if o.Paper > 0 {
		set16(c, offPaper, o.Paper)
		f |= dmFPaperSize
	}
	if o.Copies > 0 {
		set16(c, offCopies, o.Copies)
		f |= dmFCopies
	}
	if o.Source > 0 {
		set16(c, offSource, o.Source)
		f |= dmFSource
	}
	if o.Color > 0 {
		set16(c, offColor, o.Color)
		f |= dmFColor
	}
	if o.Duplex > 0 {
		set16(c, offDuplex, o.Duplex)
		f |= dmFDuplex
	}
	if o.Collate != nil {
		v := 0
		if *o.Collate {
			v = 1
		}
		set16(c, offCollate, v)
		f |= dmFCollate
	}
	binary.LittleEndian.PutUint32(c[offFields:], f)
	h, err := openPrinter(name)
	if err != nil {
		return c
	}
	defer procClosePrinter.Call(h)
	out := make([]byte, len(c))
	r, _, _ := procDocumentProperties.Call(0, h, uintptr(unsafe.Pointer(wstr(name))), uintptr(unsafe.Pointer(&out[0])), uintptr(unsafe.Pointer(&c[0])), dmInBuffer|dmOutBuffer)
	if r == 1 {
		return out
	}
	return c
}

func createDC(name string, dm []byte) (uintptr, error) {
	hdc, _, e := procCreateDC.Call(0, uintptr(unsafe.Pointer(wstr(name))), 0, uintptr(unsafe.Pointer(&dm[0])))
	if hdc == 0 {
		return 0, fmt.Errorf("could not connect to printer %q: %v", name, e)
	}
	return hdc, nil
}

func devCap(hdc uintptr, i int) int {
	r, _, _ := procGetDeviceCaps.Call(hdc, uintptr(i))
	return int(int32(r))
}

func capsFor(name string, dm []byte) (*printerCaps, error) {
	hdc, err := createDC(name, dm)
	if err != nil {
		return nil, err
	}
	defer procDeleteDC.Call(hdc)
	dpiX, dpiY := devCap(hdc, 88), devCap(hdc, 90)
	if dpiX <= 0 || dpiY <= 0 {
		dpiX, dpiY = 300, 300
	}
	physW, physH := devCap(hdc, 110), devCap(hdc, 111)
	offX, offY := devCap(hdc, 112), devCap(hdc, 113)
	horz, vert := devCap(hdc, 8), devCap(hdc, 10)
	wpt := float64(physW) / float64(dpiX) * 72
	hpt := float64(physH) / float64(dpiY) * 72
	m := 0.0
	for _, v := range []float64{float64(offX) / float64(dpiX), float64(offY) / float64(dpiY), float64(physW-horz-offX) / float64(dpiX), float64(physH-vert-offY) / float64(dpiY)} {
		if v*72 > m {
			m = v * 72
		}
	}
	if wpt > hpt {
		wpt, hpt = hpt, wpt
	}
	c := &printerCaps{Name: name, DPI: dpiX, Margin: m, Paper: paperInfo{ID: get16(dm, offPaper), W: wpt, H: hpt}}

	np := uintptr(unsafe.Pointer(wstr(name)))
	dmp := uintptr(unsafe.Pointer(&dm[0]))
	dcap := func(cap int, out unsafe.Pointer) int {
		r, _, _ := procDeviceCapabilities.Call(np, 0, uintptr(cap), uintptr(out), dmp)
		return int(int32(r))
	}
	if n := dcap(2, nil); n > 0 && n < 2000 { // DC_PAPERS
		ids := make([]uint16, n)
		names := make([]uint16, n*64)
		sizes := make([]int32, n*2)
		dcap(2, unsafe.Pointer(&ids[0]))
		dcap(16, unsafe.Pointer(&names[0])) // DC_PAPERNAMES
		dcap(3, unsafe.Pointer(&sizes[0]))  // DC_PAPERSIZE (0.1 mm)
		for i := 0; i < n; i++ {
			w, hh := float64(sizes[i*2])/254*72, float64(sizes[i*2+1])/254*72
			if w <= 0 || hh <= 0 {
				continue
			}
			if w > hh {
				w, hh = hh, w
			}
			nm := syscall.UTF16ToString(names[i*64 : i*64+64])
			if nm == "" {
				nm = "Paper " + strconv.Itoa(int(ids[i]))
			}
			c.Papers = append(c.Papers, paperInfo{ID: int(ids[i]), Name: nm, W: w, H: hh})
			if int(ids[i]) == c.Paper.ID {
				c.Paper.Name = nm
			}
		}
	}
	if n := dcap(6, nil); n > 0 && n < 500 { // DC_BINS
		ids := make([]uint16, n)
		names := make([]uint16, n*24)
		dcap(6, unsafe.Pointer(&ids[0]))
		dcap(12, unsafe.Pointer(&names[0])) // DC_BINNAMES
		for i := 0; i < n; i++ {
			c.Bins = append(c.Bins, binInfo{ID: int(ids[i]), Name: syscall.UTF16ToString(names[i*24 : i*24+24])})
		}
	}
	c.Bin = get16(dm, offSource)
	c.Duplex = dcap(7, nil) == 1 // DC_DUPLEX
	c.Color = dcap(32, nil) == 1 // DC_COLORDEVICE
	c.Cur = curSettings{Orient: get16(dm, offOrient), Copies: get16(dm, offCopies), Color: get16(dm, offColor), Duplex: get16(dm, offDuplex), Collate: get16(dm, offCollate)}
	return c, nil
}

/* ---------- API ---------- */

func prList() ([]printerInfo, string, error) {
	var res []printerInfo
	var def string
	err := onPT(func() error {
		var needed, ret uint32
		flags := uintptr(2 | 4) // PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
		procEnumPrinters.Call(flags, 0, 4, 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&ret)))
		if needed > 0 {
			buf := make([]byte, needed)
			r, _, e := procEnumPrinters.Call(flags, 0, 4, uintptr(unsafe.Pointer(&buf[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&ret)))
			if r == 0 {
				return fmt.Errorf("could not list printers: %v", e)
			}
			sz := unsafe.Sizeof(printerInfo4{})
			for i := uint32(0); i < ret; i++ {
				pi := (*printerInfo4)(unsafe.Pointer(&buf[uintptr(i)*sz]))
				res = append(res, printerInfo{Name: wstrPtr(pi.PrinterName)})
			}
		}
		n := uint32(512)
		b := make([]uint16, n)
		if r, _, _ := procGetDefaultPrinter.Call(uintptr(unsafe.Pointer(&b[0])), uintptr(unsafe.Pointer(&n))); r != 0 {
			def = syscall.UTF16ToString(b)
		}
		return nil
	})
	for i := range res {
		res[i].Default = res[i].Name == def
	}
	return res, def, err
}

func prCaps(name string) (*printerCaps, error) {
	var c *printerCaps
	err := onPT(func() error {
		dm, err := baseDevmode(name)
		if err != nil {
			return err
		}
		c, err = capsFor(name, dm)
		return err
	})
	return c, err
}

func prProperties(name string) (bool, *printerCaps, error) {
	var ok bool
	var c *printerCaps
	err := onPT(func() error {
		dm, err := baseDevmode(name)
		if err != nil {
			return err
		}
		h, err := openPrinter(name)
		if err != nil {
			return err
		}
		defer procClosePrinter.Call(h)
		np := uintptr(unsafe.Pointer(wstr(name)))
		n, _, _ := procDocumentProperties.Call(0, h, np, 0, 0, 0)
		size := int(int32(n))
		if size < len(dm) {
			size = len(dm)
		}
		out := make([]byte, size)
		hwnd, _, _ := procGetForegroundWindow.Call()
		r, _, _ := procDocumentProperties.Call(hwnd, h, np, uintptr(unsafe.Pointer(&out[0])), uintptr(unsafe.Pointer(&dm[0])), dmInBuffer|dmOutBuffer|dmInPrompt)
		if r == 1 { // IDOK
			dmStore[name] = out
			ok = true
		}
		c, err = capsFor(name, dmStore[name])
		return err
	})
	return ok, c, err
}

func prSet(name string, paper, bin int) (*printerCaps, error) {
	var c *printerCaps
	err := onPT(func() error {
		dm, err := baseDevmode(name)
		if err != nil {
			return err
		}
		dm = applyDM(name, dm, dmOv{Paper: paper, Source: bin})
		dmStore[name] = dm
		c, err = capsFor(name, dm)
		return err
	})
	return c, err
}

type winJob struct {
	name          string
	dm            []byte
	hdc           uintptr
	orient, paper int
	pages         int
}

var (
	winJobs = map[string]*winJob{}
	jobSeq  = 0
)

func prBegin(req beginReq) (string, error) {
	var id string
	err := onPT(func() error {
		base, err := baseDevmode(req.Printer)
		if err != nil {
			return err
		}
		col := req.Collate
		dm := applyDM(req.Printer, base, dmOv{Orient: req.Orient, Copies: req.Copies, Collate: &col, Color: req.Color, Duplex: req.Duplex})
		hdc, err := createDC(req.Printer, dm)
		if err != nil {
			return err
		}
		di := docInfo{DocName: wstr(req.DocName)}
		di.Size = int32(unsafe.Sizeof(di))
		r, _, _ := procStartDoc.Call(hdc, uintptr(unsafe.Pointer(&di)))
		if int32(r) <= 0 {
			procDeleteDC.Call(hdc)
			return errors.New("printing was cancelled or the printer is not available")
		}
		jobSeq++
		id = strconv.Itoa(jobSeq)
		winJobs[id] = &winJob{name: req.Printer, dm: dm, hdc: hdc, orient: get16(dm, offOrient), paper: get16(dm, offPaper)}
		return nil
	})
	return id, err
}

func prPage(id string, orient, paper int, img image.Image) error {
	return onPT(func() error {
		j := winJobs[id]
		if j == nil {
			return errors.New("print job not found")
		}
		if (orient > 0 && orient != j.orient) || (paper > 0 && paper != j.paper) {
			ov := dmOv{Orient: orient}
			if paper > 0 {
				ov.Paper = paper
			}
			dm2 := applyDM(j.name, j.dm, ov)
			if r, _, _ := procResetDC.Call(j.hdc, uintptr(unsafe.Pointer(&dm2[0]))); r != 0 {
				j.dm, j.orient, j.paper = dm2, get16(dm2, offOrient), get16(dm2, offPaper)
			}
		}
		if r, _, _ := procStartPage.Call(j.hdc); int32(r) <= 0 {
			return errors.New("the printer rejected the page")
		}
		physW, physH := devCap(j.hdc, 110), devCap(j.hdc, 111)
		offX, offY := devCap(j.hdc, 112), devCap(j.hdc, 113)
		procSetStretchBltMode.Call(j.hdc, 4) // HALFTONE
		procSetBrushOrgEx.Call(j.hdc, 0, 0, 0)
		drawImage(j.hdc, img, -offX, -offY, physW, physH)
		if r, _, _ := procEndPage.Call(j.hdc); int32(r) <= 0 {
			return errors.New("the printer could not finish the page")
		}
		j.pages++
		return nil
	})
}

func drawImage(hdc uintptr, img image.Image, dx, dy, dw, dh int) {
	b := img.Bounds()
	W, H := b.Dx(), b.Dy()
	if W == 0 || H == 0 {
		return
	}
	rowBytes := (W*3 + 3) &^ 3
	const strip = 256
	line := make([]byte, W*3)
	for y0 := 0; y0 < H; y0 += strip {
		hgt := strip
		if H-y0 < hgt {
			hgt = H - y0
		}
		buf := make([]byte, rowBytes*hgt)
		for y := 0; y < hgt; y++ {
			rowRGB(img, y0+y, line, true)
			copy(buf[y*rowBytes:], line)
		}
		bih := bitmapInfoHeader{Size: 40, Width: int32(W), Height: -int32(hgt), Planes: 1, BitCount: 24}
		ty0 := dy + y0*dh/H
		ty1 := dy + (y0+hgt)*dh/H
		procStretchDIBits.Call(hdc, uintptr(dx), uintptr(ty0), uintptr(dw), uintptr(ty1-ty0),
			0, 0, uintptr(W), uintptr(hgt), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bih)), 0, 0x00CC0020)
	}
}

func prEnd(id string) (string, error) {
	var info string
	err := onPT(func() error {
		j := winJobs[id]
		if j == nil {
			return errors.New("print job not found")
		}
		delete(winJobs, id)
		r, _, _ := procEndDoc.Call(j.hdc)
		procDeleteDC.Call(j.hdc)
		if int32(r) <= 0 {
			return errors.New("the print job could not be completed")
		}
		info = fmt.Sprintf("%d page(s) sent to %s", j.pages, j.name)
		return nil
	})
	return info, err
}

func prAbort(id string) {
	onPT(func() error {
		if j := winJobs[id]; j != nil {
			procAbortDoc.Call(j.hdc)
			procDeleteDC.Call(j.hdc)
			delete(winJobs, id)
		}
		return nil
	})
}
