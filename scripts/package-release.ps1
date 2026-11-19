param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ManifestPath = Join-Path $RootDir 'manifest.json'
if (-not (Test-Path $ManifestPath)) {
    throw "manifest.json not found at $ManifestPath"
}

$Manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$Manifest.version
if (-not $Version) {
    throw 'manifest.json is missing a valid "version" field.'
}

$ExtensionFiles = @(
    'manifest.json',
    'icons\icon16.png',
    'icons\icon48.png',
    'icons\icon128.png',
    'background.js',
    'extractor.js',
    'glossary-utils.js',
    'i18n.js',
    'page-ui.js',
    'picker.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'shortcut.js',
    'translator.js',
    'tts-player.js',
    'tts-worklet.js',
    'url-validator.js',
    'vieneu-setup.html',
    'vieneu-setup.css',
    'vieneu-setup.js'
)

$CompanionFiles = @(
    'native-host\setup_vieneu.bat',
    'native-host\install_host.bat',
    'native-host\uninstall_host.bat',
    'native-host\vieneu_host.bat',
    'native-host\vieneu_host.py',
    'native-host\vieneu_server_runner.py',
    'native-host\README.txt'
)

foreach ($rel in ($ExtensionFiles + $CompanionFiles)) {
    $full = Join-Path $RootDir $rel
    if (-not (Test-Path $full)) {
        throw "Required package file missing: $rel"
    }
}

$DistDir = Join-Path $RootDir 'dist'
$ExtZip = Join-Path $DistDir "quick-novel-translator-cws-v$Version.zip"
$CompanionZip = Join-Path $DistDir "STV-VieNeu-Companion-Windows-v$Version.zip"

if ($DryRun) {
    Write-Host "[DryRun] Version: $Version"
    Write-Host ""
    Write-Host "1) Chrome Web Store Extension ZIP -> $ExtZip"
    foreach ($rel in $ExtensionFiles) {
        Write-Host "   + $rel"
    }
    Write-Host ""
    Write-Host "2) Windows Companion ZIP -> $CompanionZip"
    foreach ($rel in $CompanionFiles) {
        $flatName = Split-Path $rel -Leaf
        Write-Host "   + $flatName (from $rel)"
    }
    exit 0
}

if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("stv-release-" + [guid]::NewGuid().ToString('N'))
$ExtStage = Join-Path $TempRoot 'ext'
$CompStage = Join-Path $TempRoot 'companion'

try {
    New-Item -ItemType Directory -Path $ExtStage -Force | Out-Null
    New-Item -ItemType Directory -Path $CompStage -Force | Out-Null

    foreach ($rel in $ExtensionFiles) {
        $src = Join-Path $RootDir $rel
        $dest = Join-Path $ExtStage $rel
        $destParent = Split-Path $dest -Parent
        if (-not (Test-Path $destParent)) {
            New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }
        Copy-Item -Path $src -Destination $dest -Force
    }

    foreach ($rel in $CompanionFiles) {
        $src = Join-Path $RootDir $rel
        $dest = Join-Path $CompStage (Split-Path $rel -Leaf)
        Copy-Item -Path $src -Destination $dest -Force
    }

    if (Test-Path $ExtZip) { Remove-Item $ExtZip -Force }
    if (Test-Path $CompanionZip) { Remove-Item $CompanionZip -Force }

    Compress-Archive -Path (Join-Path $ExtStage '*') -DestinationPath $ExtZip -CompressionLevel Optimal
    Compress-Archive -Path (Join-Path $CompStage '*') -DestinationPath $CompanionZip -CompressionLevel Optimal

    Write-Host "Packaged Chrome Web Store ZIP: $ExtZip ($([math]::Round((Get-Item $ExtZip).Length / 1KB, 1)) KB)"
    Write-Host "Packaged Windows Companion ZIP: $CompanionZip ($([math]::Round((Get-Item $CompanionZip).Length / 1KB, 1)) KB)"
} finally {
    if (Test-Path $TempRoot) {
        Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
