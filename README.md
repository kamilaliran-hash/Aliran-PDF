# Aliran PDF

View, edit, organise, sign, protect and print PDFs — for Windows and Android.

| Folder | What it is |
|---|---|
| `aliran-desktop/` | The editor (`web/index.html`) and the Windows launcher (Go). |
| `installer/` | `AliranPDF-Setup.exe`, a per-user Windows installer (no admin rights needed). |
| `android/` | Android app: the same editor in a WebView, fully offline. |

`aliran-desktop/web/index.html` is the single source for the editor. The Android build copies it
and applies a few small patches (`android/app/web-patch.gradle`), so edits there reach both apps.

## Automatic builds (GitHub Actions)

Every push to `main` builds both apps — open **Actions → Build → latest run → Artifacts**:

- `AliranPDF-windows` — `AliranPDF-Setup.exe` (installer) and `AliranPDF.exe` (portable)
- `AliranPDF-android` — `AliranPDF-debug.apk` (installable), plus `AliranPDF.apk` when signing is set up

Push a tag such as `v1.9.0` to publish both as a GitHub Release.

### Signed release APK (for sharing / Play Store)

Create a keystore once and keep it safe — every update must be signed with the same key:

```sh
keytool -genkeypair -v -keystore aliran.jks -alias aliran -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 aliran.jks   # copy the output
```

Add repository secrets (Settings → Secrets and variables → Actions):
`ALIRAN_KEYSTORE_BASE64`, `ALIRAN_KEYSTORE_PASSWORD`, `ALIRAN_KEY_ALIAS`, `ALIRAN_KEY_PASSWORD`.

## Building locally

**Windows installer** (Go 1.24+, any OS): `./build-windows.sh` → `dist/`

**Android APK** (Android Studio, or JDK 17 + Android SDK 35):

```sh
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

## What the installer does

Installs to `%LOCALAPPDATA%\Programs\Aliran PDF`, adds Start Menu and Desktop shortcuts, adds
Aliran PDF to "Open with" for PDF files, and registers an uninstaller in Settings → Apps.
Silent install: `AliranPDF-Setup.exe /S`.

## Android edition notes

- Open PDFs from the app, or from other apps via **Open with** / **Share**.
- Save / Save As / Export use the system "Save to" picker; Print uses Android's print service.
- OCR and installed system fonts are Windows-only features.
