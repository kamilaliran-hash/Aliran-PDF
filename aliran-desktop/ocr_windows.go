package main

// OCR on Windows uses the text-recognition engine built into Windows 10/11
// (Windows.Media.Ocr), driven by a long-running hidden Windows PowerShell
// process so each page doesn't pay PowerShell's start-up cost.

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const psScript = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  try { $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] } catch {}
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
  function Await($op, [Type]$t) { $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }
  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { @{ tag = $_.LanguageTag; name = $_.DisplayName } })
  $def = ''
  $e0 = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($e0) { $def = $e0.RecognizerLanguage.LanguageTag }
  Out-Json @{ ready = $true; langs = $langs; default = $def; maxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
} catch { Out-Json @{ ready = $false; error = $_.Exception.Message }; exit 1 }
$engines = @{}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $parts = $line.Split([char]'|', 2); $tag = $parts[0]; $path = $parts[1]
    if (-not $engines.ContainsKey($tag)) {
      if ($tag) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag)) }
      else { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
      if (-not $eng) { throw "OCR is not available for language '$tag'" }
      $engines[$tag] = $eng
    }
    $eng = $engines[$tag]
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $out = New-Object System.Collections.ArrayList
    foreach ($l in $res.Lines) {
      $x0 = 1e9; $y0 = 1e9; $x1 = -1e9; $y1 = -1e9
      foreach ($w in $l.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x0) { $x0 = $r.X }
        if ($r.Y -lt $y0) { $y0 = $r.Y }
        if (($r.X + $r.Width) -gt $x1) { $x1 = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $y1) { $y1 = $r.Y + $r.Height }
      }
      if ($x1 -gt $x0) { $null = $out.Add(@{ text = $l.Text; x = $x0; y = $y0; w = ($x1 - $x0); h = ($y1 - $y0) }) }
    }
    try { $stream.Dispose() } catch {}
    try { $bmp.Dispose() } catch {}
    Out-Json @{ lines = @($out) }
  } catch { Out-Json @{ error = $_.Exception.Message } }
}
`

type psProc struct {
	mu    sync.Mutex
	cmd   *exec.Cmd
	in    io.WriteCloser
	lines chan string
	info  *ocrInfo
	err   error
	tess  bool
}

var ps psProc

func (p *psProc) stop() {
	if p.cmd != nil && p.cmd.Process != nil {
		p.cmd.Process.Kill()
	}
	p.cmd, p.in, p.lines, p.info = nil, nil, nil, nil
}

func (p *psProc) readJSON(timeout time.Duration) (map[string]json.RawMessage, error) {
	deadline := time.After(timeout)
	for {
		select {
		case l, ok := <-p.lines:
			if !ok {
				return nil, errors.New("OCR engine stopped unexpectedly")
			}
			l = strings.TrimSpace(strings.TrimPrefix(l, "\ufeff"))
			if !strings.HasPrefix(l, "{") {
				continue
			}
			var m map[string]json.RawMessage
			if err := json.Unmarshal([]byte(l), &m); err != nil {
				continue
			}
			return m, nil
		case <-deadline:
			return nil, errors.New("OCR engine timed out")
		}
	}
}

func (p *psProc) start() error {
	dir, _ := os.UserCacheDir()
	if dir == "" {
		dir = os.TempDir()
	}
	dir = filepath.Join(dir, "AliranPDF")
	os.MkdirAll(dir, 0755)
	script := filepath.Join(dir, "ocr.ps1")
	if err := os.WriteFile(script, []byte("\ufeff"+psScript), 0644); err != nil {
		return err
	}
	exe := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(exe); err != nil {
		exe = "powershell.exe"
	}
	cmd := exec.Command(exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
	hide(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	ch := make(chan string, 4)
	go func() {
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 1<<20), 1<<26)
		for sc.Scan() {
			ch <- sc.Text()
		}
		close(ch)
		cmd.Wait()
	}()
	p.cmd, p.in, p.lines = cmd, in, ch
	m, err := p.readJSON(60 * time.Second)
	if err != nil {
		p.stop()
		return err
	}
	var ready bool
	json.Unmarshal(m["ready"], &ready)
	if !ready {
		var msg string
		json.Unmarshal(m["error"], &msg)
		p.stop()
		return errors.New("Windows OCR is unavailable: " + msg)
	}
	info := &ocrInfo{Available: true, Engine: "windows", MaxDim: 2600}
	json.Unmarshal(m["langs"], &info.Langs)
	json.Unmarshal(m["default"], &info.Default)
	var md int
	if json.Unmarshal(m["maxDim"], &md) == nil && md > 0 {
		info.MaxDim = md
	}
	if len(info.Langs) == 0 {
		p.stop()
		return errors.New("no OCR languages are installed in Windows (add a language pack in Settings → Time & language → Language)")
	}
	if info.Default == "" {
		info.Default = info.Langs[0].Tag
	}
	p.info = info
	return nil
}

func backendInfo() ocrInfo {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.info != nil {
		return *ps.info
	}
	if err := ps.start(); err != nil {
		if t := tessInfo(); t.Available { // optional fallback if Tesseract is installed
			ps.tess = true
			return t
		}
		return ocrInfo{Available: false, Error: err.Error()}
	}
	ps.tess = false
	return *ps.info
}

func backendRecognize(lang, path string) ([]ocrLine, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.tess {
		return tessRecognize(lang, path)
	}
	if ps.info == nil {
		if err := ps.start(); err != nil {
			return nil, err
		}
	}
	if _, err := io.WriteString(ps.in, lang+"|"+path+"\n"); err != nil {
		ps.stop()
		return nil, err
	}
	m, err := ps.readJSON(3 * time.Minute)
	if err != nil {
		ps.stop()
		return nil, err
	}
	if e, ok := m["error"]; ok {
		var msg string
		json.Unmarshal(e, &msg)
		return nil, errors.New(msg)
	}
	var lines []ocrLine
	if err := json.Unmarshal(m["lines"], &lines); err != nil {
		return nil, err
	}
	return lines, nil
}
