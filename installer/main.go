// Aliran PDF Setup — a self-contained per-user Windows installer.
//
//	AliranPDF-Setup.exe            install (asks for confirmation)
//	AliranPDF-Setup.exe /S         silent install
//	"Uninstall Aliran PDF.exe" --uninstall [/S]
//
// Installs to %LOCALAPPDATA%\Programs\Aliran PDF (no admin rights needed), creates
// Start Menu and Desktop shortcuts, registers Aliran PDF under "Open with" for .pdf
// and adds an entry to Settings > Apps so it can be uninstalled normally.
package main

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed payload/AliranPDF.exe.gz
var payload []byte

const (
	appName   = "Aliran PDF"
	exeName   = "AliranPDF.exe"
	uninstExe = "Uninstall Aliran PDF.exe"
	progID    = "AliranPDF.Document"
	uninstKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AliranPDF`
)

var version = "1.0.0" // set with -ldflags "-X main.version=..."

var silent bool

func main() {
	uninstall := false
	for _, a := range os.Args[1:] {
		switch strings.ToLower(a) {
		case "/s", "-s", "/silent", "--silent":
			silent = true
		case "--uninstall", "/uninstall":
			uninstall = true
		}
	}
	if strings.EqualFold(filepath.Base(os.Args[0]), uninstExe) {
		uninstall = true
	}
	if uninstall {
		doUninstall()
		return
	}
	doInstall()
}

func installDir() string {
	la := os.Getenv("LOCALAPPDATA")
	if la == "" {
		h, _ := os.UserHomeDir()
		la = filepath.Join(h, "AppData", "Local")
	}
	return filepath.Join(la, "Programs", appName)
}

func startMenuLnk() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, appName+".lnk")
}

func desktopLnk() string {
	h, _ := os.UserHomeDir()
	if p := os.Getenv("USERPROFILE"); p != "" {
		h = p
	}
	return filepath.Join(h, "Desktop", appName+".lnk")
}

func doInstall() {
	if !silent && !ask(fmt.Sprintf("Install %s %s for this user?\n\nLocation: %s", appName, version, installDir())) {
		return
	}
	dir := installDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		fatal("Could not create the install folder:\n" + err.Error())
	}
	// Close a running copy so its exe can be replaced.
	run("taskkill", "/F", "/IM", exeName)
	time.Sleep(300 * time.Millisecond)

	exePath := filepath.Join(dir, exeName)
	if err := writePayload(exePath); err != nil {
		fatal("Could not write " + exeName + ":\n" + err.Error())
	}
	self, _ := os.Executable()
	uninstPath := filepath.Join(dir, uninstExe)
	if err := copyFile(self, uninstPath); err != nil {
		fatal("Could not write the uninstaller:\n" + err.Error())
	}

	// Shortcuts.
	shortcut(startMenuLnk(), exePath, dir)
	shortcut(desktopLnk(), exePath, dir)

	// "Open with" registration for PDF files (per user, does not take over the default app).
	q := `"` + exePath + `" "%1"`
	reg("add", `HKCU\Software\Classes\`+progID, "/ve", "/d", "PDF Document", "/f")
	reg("add", `HKCU\Software\Classes\`+progID+`\DefaultIcon`, "/ve", "/d", exePath+",0", "/f")
	reg("add", `HKCU\Software\Classes\`+progID+`\shell\open\command`, "/ve", "/d", q, "/f")
	reg("add", `HKCU\Software\Classes\.pdf\OpenWithProgids`, "/v", progID, "/t", "REG_NONE", "/f")
	reg("add", `HKCU\Software\Classes\Applications\`+exeName, "/v", "FriendlyAppName", "/d", appName, "/f")
	reg("add", `HKCU\Software\Classes\Applications\`+exeName+`\SupportedTypes`, "/v", ".pdf", "/d", "", "/f")
	reg("add", `HKCU\Software\Classes\Applications\`+exeName+`\shell\open\command`, "/ve", "/d", q, "/f")

	// Settings > Apps entry.
	size := uint32(0)
	if st, err := os.Stat(exePath); err == nil {
		size = uint32(st.Size() / 1024)
	}
	reg("add", uninstKey, "/v", "DisplayName", "/d", appName, "/f")
	reg("add", uninstKey, "/v", "DisplayVersion", "/d", version, "/f")
	reg("add", uninstKey, "/v", "Publisher", "/d", appName, "/f")
	reg("add", uninstKey, "/v", "DisplayIcon", "/d", exePath+",0", "/f")
	reg("add", uninstKey, "/v", "InstallLocation", "/d", dir, "/f")
	reg("add", uninstKey, "/v", "UninstallString", "/d", `"`+uninstPath+`" --uninstall`, "/f")
	reg("add", uninstKey, "/v", "QuietUninstallString", "/d", `"`+uninstPath+`" --uninstall /S`, "/f")
	reg("add", uninstKey, "/v", "EstimatedSize", "/t", "REG_DWORD", "/d", fmt.Sprint(size), "/f")
	reg("add", uninstKey, "/v", "NoModify", "/t", "REG_DWORD", "/d", "1", "/f")
	reg("add", uninstKey, "/v", "NoRepair", "/t", "REG_DWORD", "/d", "1", "/f")
	notifyAssoc()

	if !silent && ask(appName+" has been installed.\n\nOpen it now?") {
		exec.Command(exePath).Start()
	}
}

func doUninstall() {
	if !silent && !ask("Remove "+appName+" from this computer?") {
		return
	}
	dir := installDir()
	run("taskkill", "/F", "/IM", exeName)
	os.Remove(startMenuLnk())
	os.Remove(desktopLnk())
	reg("delete", `HKCU\Software\Classes\`+progID, "/f")
	reg("delete", `HKCU\Software\Classes\.pdf\OpenWithProgids`, "/v", progID, "/f")
	reg("delete", `HKCU\Software\Classes\Applications\`+exeName, "/f")
	reg("delete", uninstKey, "/f")
	notifyAssoc()
	os.Remove(filepath.Join(dir, exeName))

	// This exe may be running from the install folder: remove the folder after we exit.
	cmd := exec.Command("cmd", "/C", "ping -n 3 127.0.0.1 >nul & rmdir /S /Q \""+dir+"\"")
	hide(cmd)
	cmd.Start()
	if !silent {
		info(appName + " has been removed.")
	}
}

func writePayload(dst string) error {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return err
	}
	tmp := dst + ".new"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err = io.Copy(f, zr); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

func copyFile(src, dst string) error {
	if strings.EqualFold(filepath.Clean(src), filepath.Clean(dst)) {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func shortcut(lnk, target, workDir string) {
	os.MkdirAll(filepath.Dir(lnk), 0755)
	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	ps := fmt.Sprintf(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s,0';$s.Description='%s';$s.Save()`,
		esc(lnk), esc(target), esc(workDir), esc(target), appName)
	run("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps)
}

func reg(args ...string) { run("reg", args...) }

func run(name string, args ...string) error {
	c := exec.Command(name, args...)
	hide(c)
	return c.Run()
}

func hide(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} }

// Tell Explorer that file associations changed.
func notifyAssoc() {
	syscall.NewLazyDLL("shell32.dll").NewProc("SHChangeNotify").Call(0x08000000, 0, 0, 0)
}

func msgBox(text string, flags uintptr) uintptr {
	t, _ := syscall.UTF16PtrFromString(appName + " Setup")
	m, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").
		Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
	return r
}

func ask(text string) bool { return msgBox(text, 0x04|0x20) == 6 } // MB_YESNO|MB_ICONQUESTION -> IDYES
func info(text string)     { msgBox(text, 0x40) }

func fatal(text string) {
	if !silent {
		msgBox(text, 0x10)
	}
	os.Exit(1)
}
