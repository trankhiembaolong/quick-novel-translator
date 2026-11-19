@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ==================================================
echo  Go cai dat Native Messaging Host STV - VieNeu
echo ==================================================
echo.

set "STATE_DIR=%LOCALAPPDATA%\STV-VieNeu"
set "PID_FILE=%STATE_DIR%\vieneu_server.pid"
set "HOST_DIR=%STATE_DIR%\host"

if exist "%PID_FILE%" (
    for /f "usebackq delims=" %%P in ("%PID_FILE%") do (
        taskkill /PID %%P /T /F >nul 2>&1
    )
    del /q "%PID_FILE%" >nul 2>&1
)

reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stv.vieneu_host" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.stv.vieneu_host" /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.stv.vieneu_host" /f >nul 2>&1

if exist "%HOST_DIR%" (
    rmdir /s /q "%HOST_DIR%" >nul 2>&1
)

echo [THANH CONG] Da go bo Native Messaging Host khoi Chrome, Edge, Brave va %HOST_DIR%.
echo Luu y: Thu muc ma nguon VieNeu-TTS (neu da clone) khong bi xoa tu dong.
echo.
pause
exit /b 0
