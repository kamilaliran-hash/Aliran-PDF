# Aliran PDF

View, edit, organise, sign, protect and print PDFs — for Windows and Android.

| Folder | What it is |
|---|---|
| `aliran-desktop/` | The editor (`web/index.html`) and the Windows launcher (Go). |
| `installer/` | `AliranPDF-Setup.exe`, a per-user Windows installer (no admin rights needed). |
| `aliran-desktop/android/` | Android app: the same editor (`../web`) in a WebView, fully offline. |

`aliran-desktop/web/index.html` is the single source for the editor; the Android build copies it into
the APK, so edits there reach both apps.

## Automatic builds (GitHub Actions)

Every push to `main` builds both apps — open **Actions → Build → latest run → Artifacts**:

- `AliranPDF-windows` — `AliranPDF-Setup.exe` (installer) and `AliranPDF.exe` (portable)
- `AliranPDF-android` — `AliranPDF.apk`, signed with your release key (or `AliranPDF-debug.apk` if the signing secret is missing)

Push a tag such as `v1.9.0` to publish both as a GitHub Release.

### Signing key (required for the release APK)

The key `aliran-release.jks` must never be committed — this repo is public. Give it to GitHub as a secret:
Settings → Secrets and variables → Actions → **New repository secret**

- `ALIRAN_KEYSTORE_BASE64` — the keystore as base64 (`base64 -w0 aliran-release.jks`, or on Windows
  `certutil -encodehex -f aliran-release.jks out.txt 0x40000001`)
- `ALIRAN_KEYSTORE_PASSWORD` — optional; defaults to the project's password

Keep a safe copy of the .jks: every update must be signed with the same key.

## Building locally

**Windows installer** (Go 1.24+, any OS): `./build-windows.sh` → `dist/`

**Android APK** (Android Studio, or JDK 17 + Android SDK 35):

Put `aliran-release.jks` in `aliran-desktop/android/app/`, then run `aliran-desktop/android/build-apk.bat`
(or open `aliran-desktop/android` in Android Studio → Build → Build APK).

## What the installer does

Installs to `%LOCALAPPDATA%\Programs\Aliran PDF`, adds Start Menu and Desktop shortcuts, adds
Aliran PDF to "Open with" for PDF files, and registers an uninstaller in Settings → Apps.
Silent install: `AliranPDF-Setup.exe /S`.

## Android edition notes

- Open PDFs from the app, or from other apps via **Open with** / **Share**.
- Save / Save As / Export use the system "Save to" picker; Print uses Android's print service.
- OCR and installed system fonts are Windows-only features.
