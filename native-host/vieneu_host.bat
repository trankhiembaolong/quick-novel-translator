@echo off
setlocal enabledelayedexpansion
set "PY_CMD=python"
if defined VIENEU_TTS_DIR (
    if exist "%VIENEU_TTS_DIR%\.venv\Scripts\python.exe" set "PY_CMD=%VIENEU_TTS_DIR%\.venv\Scripts\python.exe"
)
if "%PY_CMD%"=="python" (
    for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$c = Join-Path '%~dp0' 'vieneu_config.json'; if (Test-Path $c) { $d = (Get-Content $c -Raw | ConvertFrom-Json).vieneu_dir; $p = Join-Path $d '.venv\Scripts\python.exe'; if (Test-Path $p) { $p } }"`) do set "PY_CMD=%%I"
)
"%PY_CMD%" -u "%~dp0vieneu_host.py"
