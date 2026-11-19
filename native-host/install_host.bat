@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ==================================================
echo  Cai dat Native Messaging Host cho STV - VieNeu
echo ==================================================
echo.

set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

set "EXT_ID=%~1"
set "ARG_VIENEU_DIR=%~2"
set "NO_PAUSE=0"

if /i "%~1"=="--no-pause" (
    set "EXT_ID="
    set "ARG_VIENEU_DIR="
    set "NO_PAUSE=1"
) else if /i "%~2"=="--no-pause" (
    set "ARG_VIENEU_DIR="
    set "NO_PAUSE=1"
) else if /i "%~3"=="--no-pause" (
    set "NO_PAUSE=1"
)

set "VIENEU_DIR="
if not "%ARG_VIENEU_DIR%"=="" (
    if exist "%ARG_VIENEU_DIR%\.venv\Scripts\python.exe" set "VIENEU_DIR=%ARG_VIENEU_DIR%"
)
if "%VIENEU_DIR%"=="" if not "%VIENEU_TTS_DIR%"=="" (
    if exist "%VIENEU_TTS_DIR%\.venv\Scripts\python.exe" set "VIENEU_DIR=%VIENEU_TTS_DIR%"
)
if "%VIENEU_DIR%"=="" if not "%VIENEU_PATH%"=="" (
    if exist "%VIENEU_PATH%\.venv\Scripts\python.exe" set "VIENEU_DIR=%VIENEU_PATH%"
)

if "%VIENEU_DIR%"=="" (
    for %%D in (
        "%USERPROFILE%\vieneu-tts"
        "%USERPROFILE%\VieNeu-TTS"
        "%USERPROFILE%\Documents\vieneu-tts"
        "%USERPROFILE%\Documents\VieNeu-TTS"
        "%USERPROFILE%\Downloads\vieneu-tts"
        "%USERPROFILE%\Downloads\VieNeu-TTS"
        "%USERPROFILE%\Desktop\vieneu-tts"
        "%USERPROFILE%\Desktop\VieNeu-TTS"
    ) do (
        if "%VIENEU_DIR%"=="" if exist "%%~D\.venv\Scripts\python.exe" set "VIENEU_DIR=%%~D"
    )
)

if "%VIENEU_DIR%"=="" (
    if not "%ARG_VIENEU_DIR%"=="" (
        set "VIENEU_DIR=%ARG_VIENEU_DIR%"
    ) else (
        set "VIENEU_DIR=%USERPROFILE%\vieneu-tts"
    )
)

if not exist "%VIENEU_DIR%\.venv\Scripts\python.exe" (
    echo [CANH BAO] Chua tim thay .venv tai: %VIENEU_DIR%
    set /p INPUT_DIR="Nhap duong dan thu muc vieneu-tts (hoac nhan Enter de giu mac dinh): "
    if not "!INPUT_DIR!"=="" (
        set "INPUT_DIR=!INPUT_DIR:"=!"
        set "VIENEU_DIR=!INPUT_DIR!"
    )
)

set "VIENEU_PY=%VIENEU_DIR%\.venv\Scripts\python.exe"
if not exist "%VIENEU_PY%" (
    echo [CANH BAO] Khong tim thay Python VieNeu tai: %VIENEU_PY%
    echo Neu ban chua cai VieNeu-TTS, hay chay setup_vieneu.bat hoac lam theo muc 2 trong trang huong dan.
    echo.
)

if "%EXT_ID%"=="" (
    echo Mo trang Huong dan trong Extension hoac chrome://extensions ^(Developer mode^) de lay Extension ID.
    set /p EXT_ID="Dan Extension ID ^(32 ky tu a-p^) vao day roi nhan Enter: "
)

set "EXT_ID=%EXT_ID: =%"
set "EXT_ID=%EXT_ID:"=%"
if "%EXT_ID%"=="" (
    echo [LOI] Extension ID khong duoc de trong!
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

powershell -NoProfile -Command "if ('%EXT_ID%' -notmatch '^[a-p]{32}$') { exit 1 }"
if errorlevel 1 (
    echo [LOI] Extension ID khong hop le! Phai gom dung 32 ky tu thuong a-p.
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

set "INSTALL_DIR=%LOCALAPPDATA%\STV-VieNeu\host"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

for %%F in (vieneu_host.py vieneu_server_runner.py vieneu_host.bat) do (
    if not exist "%SRC_DIR%\%%F" (
        echo [LOI] Thieu file companion: "%SRC_DIR%\%%F"
        if "%NO_PAUSE%"=="0" pause
        exit /b 1
    )
    copy /Y "%SRC_DIR%\%%F" "%INSTALL_DIR%\%%F" >nul
    if errorlevel 1 (
        echo [LOI] Khong the sao chep file %%F vao "%INSTALL_DIR%".
        if "%NO_PAUSE%"=="0" pause
        exit /b 1
    )
)

set "CFG_PATH=%INSTALL_DIR%\vieneu_config.json"
set "BAT_PATH=%INSTALL_DIR%\vieneu_host.bat"
set "MANIFEST_PATH=%INSTALL_DIR%\com.stv.vieneu_host.json"

powershell -NoProfile -Command "$enc = [System.Text.UTF8Encoding]::new($false); $cfg = @{ vieneu_dir = $env:VIENEU_DIR } | ConvertTo-Json; [System.IO.File]::WriteAllText($env:CFG_PATH, $cfg, $enc); $manifest = @{ name = 'com.stv.vieneu_host'; description = 'STV Extension VieNeu-TTS Background Server Controller'; path = $env:BAT_PATH; type = 'stdio'; allowed_origins = @('chrome-extension://' + $env:EXT_ID + '/') } | ConvertTo-Json; [System.IO.File]::WriteAllText($env:MANIFEST_PATH, $manifest, $enc)"
if errorlevel 1 (
    echo [LOI] Khong the ghi file cau hinh JSON vao "%INSTALL_DIR%".
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stv.vieneu_host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.stv.vieneu_host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.stv.vieneu_host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo.
echo [THANH CONG] Da cai dat Native Messaging Host vao:
echo   %INSTALL_DIR%
echo Thu muc VieNeu-TTS: %VIENEU_DIR%
echo Extension ID: %EXT_ID%
echo Da dang ky cho Chrome, Edge va Brave.
echo Ban co the xoa thu muc giai nen nay va bam "Kiem tra Native Host" hoac "Bat Server" trong Extension.
echo.
if "%NO_PAUSE%"=="0" pause
exit /b 0
