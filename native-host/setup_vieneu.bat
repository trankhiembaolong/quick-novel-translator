@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ========================================================
echo  Cai dat tron goi VieNeu-TTS & Native Host cho STV
echo ========================================================
echo.

set "EXT_ID=%~1"
set "EXT_ID=%EXT_ID: =%"
set "EXT_ID=%EXT_ID:"=%"

if "%EXT_ID%"=="" (
    echo Mo trang "Huong dan & Cai dat VieNeu" trong Extension STV de copy Extension ID.
    set /p EXT_ID="Dan Extension ID (32 ky tu a-p) vao day roi nhan Enter: "
    set "EXT_ID=!EXT_ID: =!"
    set "EXT_ID=!EXT_ID:"=!"
)

if "%EXT_ID%"=="" (
    echo [LOI] Extension ID khong duoc de trong!
    pause
    exit /b 1
)

powershell -NoProfile -Command "if ('%EXT_ID%' -notmatch '^[a-p]{32}$') { exit 1 }"
if errorlevel 1 (
    echo [LOI] Extension ID khong hop le! Phai gom dung 32 ky tu thuong a-p.
    pause
    exit /b 1
)

set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%ProgramFiles%\Git\cmd;%ProgramFiles%\eSpeak NG;%ProgramFiles(x86)%\eSpeak NG;%PATH%"

echo [1/4] Kiem tra cong cu nen (Git, eSpeak NG, uv)...
where winget >nul 2>&1
set "HAS_WINGET=1"
if errorlevel 1 set "HAS_WINGET=0"

where git >nul 2>&1
if errorlevel 1 (
    echo   - Chua co Git. Dang tien hanh cai dat...
    if "%HAS_WINGET%"=="1" (
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    ) else (
        echo [LOI] Khong tim thay winget. Vui long cai Git tai https://git-scm.com/downloads roi chay lai.
        pause
        exit /b 1
    )
)

set "HAS_ESPEAK=0"
where espeak-ng >nul 2>&1 && set "HAS_ESPEAK=1"
if "%HAS_ESPEAK%"=="0" if exist "%ProgramFiles%\eSpeak NG\espeak-ng.exe" set "HAS_ESPEAK=1"
if "%HAS_ESPEAK%"=="0" if exist "%ProgramFiles(x86)%\eSpeak NG\espeak-ng.exe" set "HAS_ESPEAK=1"
if "%HAS_ESPEAK%"=="0" (
    echo   - Chua co eSpeak NG. Dang tien hanh cai dat...
    if "%HAS_WINGET%"=="1" (
        winget install --id eSpeak-NG.eSpeak-NG -e --source winget --accept-package-agreements --accept-source-agreements
    ) else (
        echo [CANH BAO] Chua co eSpeak NG. Hay tai file .msi tai:
        echo   https://github.com/espeak-ng/espeak-ng/releases/latest
    )
)

where uv >nul 2>&1
if errorlevel 1 (
    echo   - Chua co uv. Dang tai va cai dat uv...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
)

set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%ProgramFiles%\Git\cmd;%ProgramFiles%\eSpeak NG;%ProgramFiles(x86)%\eSpeak NG;%PATH%"

where git >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong nhan dien duoc lenh git sau khi cai. Hay dong cua so nay, mo PowerShell moi va chay lai.
    pause
    exit /b 1
)

where uv >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong nhan dien duoc lenh uv sau khi cai. Hay dong cua so nay, mo PowerShell moi va chay lai.
    pause
    exit /b 1
)

echo.
echo [2/4] Chuan bi ma nguon VieNeu-TTS...
set "DEFAULT_DIR=%USERPROFILE%\vieneu-tts"
set /p INPUT_DIR="Thu muc cai VieNeu-TTS [Nhan Enter = %DEFAULT_DIR%]: "
if "%INPUT_DIR%"=="" (
    set "VIENEU_DIR=%DEFAULT_DIR%"
) else (
    set "VIENEU_DIR=%INPUT_DIR:"=%"
)

if exist "%VIENEU_DIR%\.git" (
    echo   - Da co thu muc VieNeu-TTS tai: %VIENEU_DIR%
) else (
    echo   - Dang clone VieNeu-TTS vao: %VIENEU_DIR%
    git clone https://github.com/pnnbao97/VieNeu-TTS.git "%VIENEU_DIR%"
    if errorlevel 1 (
        echo [LOI] Khong clone duoc repository VieNeu-TTS. Kiem tra ket noi mang hoac thu muc dich.
        pause
        exit /b 1
    )
)

echo.
echo [3/4] Chon phan cung de dong bo thu vien (.venv):
echo   [1] CPU (Khuyen dung - moi may Windows, dung ONNX Runtime)
echo   [2] GPU NVIDIA (CUDA)
echo   [3] GPU AMD Radeon (DirectML)
set /p HW_CHOICE="Nhap lua chon (1/2/3, mac dinh 1): "
if "%HW_CHOICE%"=="" set "HW_CHOICE=1"

pushd "%VIENEU_DIR%"
if "%HW_CHOICE%"=="2" (
    echo   - Dang cai dat VieNeu cho NVIDIA GPU ^(CUDA^)...
    uv sync --extra cuda
    if errorlevel 1 (
        popd
        echo [LOI] uv sync --extra cuda that bai.
        pause
        exit /b 1
    )
) else if "%HW_CHOICE%"=="3" (
    echo   - Dang cai dat VieNeu cho AMD GPU ^(DirectML^)...
    uv sync
    if errorlevel 1 (
        popd
        echo [LOI] uv sync that bai.
        pause
        exit /b 1
    )
    uv pip install onnxruntime-directml
    if errorlevel 1 (
        popd
        echo [LOI] Khong cai duoc onnxruntime-directml.
        pause
        exit /b 1
    )
) else (
    echo   - Dang cai dat VieNeu cho CPU ^(ONNX Runtime^)...
    uv sync
    if errorlevel 1 (
        popd
        echo [LOI] uv sync that bai.
        pause
        exit /b 1
    )
)
popd

echo.
echo [4/4] Dang ky Native Messaging Host...
call "%~dp0install_host.bat" "%EXT_ID%" "%VIENEU_DIR%" --no-pause
if errorlevel 1 (
    echo [LOI] Dang ky Native Messaging Host that bai.
    pause
    exit /b 1
)

echo.
set /p PRELOAD_ANS="Ban co muon tai truoc bo model AI (~1-2 GB) ngay bay gio khong? [Y/n]: "
if /i not "%PRELOAD_ANS%"=="n" (
    echo Dang tai/kiem tra model VieNeu lan dau ^(co the mat 1-5 phut^)...
    pushd "%VIENEU_DIR%"
    "%VIENEU_DIR%\.venv\Scripts\python.exe" -c "from vieneu import Vieneu; Vieneu(); print('Model VieNeu da san sang!')"
    if errorlevel 1 (
        echo [CANH BAO] Chua tai xong model tu buoc kiem tra. Lan dau bam Bat Server se tiep tuc tai ngam.
    )
    popd
)

echo.
echo ========================================================
echo  HOAN TAT! Ban da co the su dung VieNeu-TTS trong STV.
echo  - Mo Extension STV -> tab Nghe -> chon "VieNeu Local Server"
echo  - Bam "Bat Server" va thu nghe truyen.
echo ========================================================
pause
exit /b 0
