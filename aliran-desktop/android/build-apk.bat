@echo off
rem Builds AliranPDF.apk on Windows.
rem Needs Android Studio installed once (it brings Java and the Android SDK).
setlocal
if "%JAVA_HOME%"=="" if exist "%ProgramFiles%\Android\Android Studio\jbr" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if "%ANDROID_HOME%"=="" if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%ANDROID_HOME%"=="" (
  echo Android SDK not found. Install Android Studio, open it once, then run this again.
  pause & exit /b 1
)
cd /d "%~dp0"
call gradlew.bat --no-daemon assembleRelease || (pause & exit /b 1)
copy /y "app\build\outputs\apk\release\app-release.apk" "..\AliranPDF.apk" >nul
echo.
echo Done: %~dp0..\AliranPDF.apk
pause
