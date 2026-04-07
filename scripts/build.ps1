# Oblivinx3x Build Script — Windows PowerShell
# Usage: .\scripts\build.ps1 [-Debug] [-SkipNpm]
#
# Builds the Rust native addon and copies it to the correct location
# for local development AND for population of the platform npm package.

param(
    [switch]$Debug,
    [switch]$SkipNpm,
    [switch]$Help
)

if ($Help) {
    Write-Host @"
Oblivinx3x Build Script (Windows PowerShell)

Usage:
  .\scripts\build.ps1              # Release build (optimized)
  .\scripts\build.ps1 -Debug       # Debug build (faster compile)
  .\scripts\build.ps1 -SkipNpm     # Skip npm install

Steps:
  1. Check Rust/Cargo availability
  2. Build ovn-neon native addon
  3. Copy .dll → .node (Node.js expects .node extension)
  4. npm install (optional)
"@
    exit 0
}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  Oblivinx3x Build Script (Windows)   ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check dependencies ──────────────────────────────────
Write-Host "[1/4] Checking build dependencies..." -ForegroundColor Yellow

if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  ✗ Cargo (Rust) is not installed or not in PATH." -ForegroundColor Red
    Write-Host "    Install Rust from: https://rustup.rs/" -ForegroundColor Red
    exit 1
}

$rustVersion = & cargo --version 2>&1
Write-Host "  ✓ $rustVersion" -ForegroundColor Green

# ── Step 2: Build Rust native addon ─────────────────────────────
$profile = if ($Debug) { "debug" } else { "release" }
$cargoFlag = if ($Debug) { "" } else { "--release" }

Write-Host ""
Write-Host "[2/4] Building ovn-neon ($profile profile)..." -ForegroundColor Yellow
Write-Host "      This may take a few minutes on first build..." -ForegroundColor DarkGray
Write-Host ""

Set-Location $Root
$buildResult = & cargo build $cargoFlag -p ovn-neon 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ✗ Cargo build failed!" -ForegroundColor Red
    Write-Host $buildResult
    exit 1
}

Write-Host "  ✓ Build succeeded" -ForegroundColor Green

# ── Step 3: Copy .dll → .node ────────────────────────────────────
Write-Host ""
Write-Host "[3/4] Copying native addon..." -ForegroundColor Yellow

$dllPath  = Join-Path $Root "target\$profile\ovn_neon.dll"
$nodePath = Join-Path $Root "target\$profile\ovn_neon.node"

# Also copy to the platform package directory
$pkgDir = Join-Path $Root "packages\oblivinx3x-win32-x64-msvc"

if (Test-Path $dllPath) {
    Copy-Item -Path $dllPath -Destination $nodePath -Force
    Write-Host "  ✓ target\$profile\ovn_neon.dll → target\$profile\ovn_neon.node" -ForegroundColor Green

    # Copy to platform package
    if (Test-Path $pkgDir) {
        $pkgNodePath = Join-Path $pkgDir "ovn_neon.node"
        Copy-Item -Path $dllPath -Destination $pkgNodePath -Force
        Write-Host "  ✓ Copied to packages\oblivinx3x-win32-x64-msvc\ovn_neon.node" -ForegroundColor Green
    }
} else {
    Write-Host "  ✗ Expected DLL not found at: $dllPath" -ForegroundColor Red
    Write-Host "    Something went wrong with the cargo build." -ForegroundColor Red
    exit 1
}

# ── Step 4: npm install ──────────────────────────────────────────
if (-not $SkipNpm) {
    Write-Host ""
    Write-Host "[4/4] Running npm install..." -ForegroundColor Yellow

    if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
        Write-Host "  ⚠ npm not found — skipping npm install" -ForegroundColor DarkYellow
    } else {
        & npm install 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✓ npm install completed" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ npm install had warnings (may be OK)" -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "[4/4] Skipping npm install (-SkipNpm)" -ForegroundColor DarkGray
}

# ── Done ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║        Build Complete! ✓              ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Native addon: target\$profile\ovn_neon.node" -ForegroundColor White
Write-Host ""
Write-Host "  Quick test:" -ForegroundColor White
Write-Host "    node --test tests\integration\engine.test.js" -ForegroundColor DarkGray
Write-Host ""
