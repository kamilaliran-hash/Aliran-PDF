#!/usr/bin/env sh
# Builds dist/AliranPDF.exe and dist/AliranPDF-Setup.exe (needs Go 1.24+; works on Linux, macOS or Windows/Git Bash).
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n "s/^const APP_VERSION = '\([0-9.]*\)'.*/\1/p" aliran-desktop/web/index.html)
mkdir -p dist installer/payload
(cd aliran-desktop && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o ../dist/AliranPDF.exe .)
gzip -9 -c dist/AliranPDF.exe > installer/payload/AliranPDF.exe.gz
(cd installer && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$VERSION" -o ../dist/AliranPDF-Setup.exe .)
echo "Built Aliran PDF $VERSION:"; ls -l dist
