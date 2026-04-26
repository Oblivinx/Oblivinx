#!/usr/bin/env node
/**
 * Oblivinx3x — Cross-platform Native Addon Build Script
 *
 * Compiles the Rust `ovn-neon` crate into a Node.js native addon (.node)
 * and copies it into `packages/oblivinx3x/native/`.
 *
 * Usage:
 *   node scripts/build-native.js          # Release build
 *   node scripts/build-native.js --debug  # Debug build
 *
 * This script replaces the need for node-gyp entirely.
 * Neon + Cargo is the correct build system for Rust→Node.js addons.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────
const isDebug = process.argv.includes('--debug');
const profile = isDebug ? 'debug' : 'release';
const cargoFlag = isDebug ? '' : '--release';

// Resolve paths relative to this script
// Script is at: packages/oblivinx3x/scripts/build-native.js
// Workspace root is: ../../..
const scriptDir = __dirname;
const packageRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const nativeDir = path.join(packageRoot, 'native');

// Platform-specific library extension
const libExtMap = {
  win32: 'dll',
  darwin: 'dylib',
  linux: 'so',
};
const libExt = libExtMap[process.platform] || 'so';

// Source DLL/so/dylib path
const srcPath = path.join(workspaceRoot, 'target', profile, `ovn_neon.${libExt}`);
const destPath = path.join(nativeDir, 'ovn_neon.node');

// ── Utility ───────────────────────────────────────────────────────
function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function header(msg) {
  console.log('');
  console.log(`  ╔${'═'.repeat(msg.length + 4)}╗`);
  console.log(`  ║  ${msg}  ║`);
  console.log(`  ╚${'═'.repeat(msg.length + 4)}╝`);
  console.log('');
}

// ── Step 1: Check Rust toolchain ──────────────────────────────────
function checkRust() {
  try {
    const version = execSync('cargo --version', { encoding: 'utf-8' }).trim();
    log('✓', `Rust toolchain: ${version}`);
    return true;
  } catch {
    return false;
  }
}

// ── Step 2: Build Rust native addon ───────────────────────────────
function buildRust() {
  log('⚙', `Building ovn-neon (${profile} profile)...`);
  console.log('');

  try {
    execSync(`cargo build ${cargoFlag} -p ovn-neon`, {
      cwd: workspaceRoot,
      stdio: 'inherit', // Show cargo output in real-time
      env: { ...process.env },
    });
    console.log('');
    log('✓', 'Rust build completed successfully');
    return true;
  } catch (err) {
    console.log('');
    log('✗', `Rust build failed: ${err.message}`);
    return false;
  }
}

// ── Step 3: Copy artifact ─────────────────────────────────────────
function copyArtifact() {
  // Ensure native/ directory exists
  if (!fs.existsSync(nativeDir)) {
    fs.mkdirSync(nativeDir, { recursive: true });
    log('✓', 'Created native/ directory');
  }

  if (!fs.existsSync(srcPath)) {
    log('✗', `Build artifact not found: ${srcPath}`);
    log('!', 'The cargo build may have succeeded but the DLL was not produced.');
    log('!', `Expected: ovn_neon.${libExt} in target/${profile}/`);
    return false;
  }

  fs.copyFileSync(srcPath, destPath);
  const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(2);
  log('✓', `Copied ovn_neon.${libExt} → native/ovn_neon.node (${sizeMB} MB)`);
  return true;
}

// ── Step 4: Check for prebuilt binary ─────────────────────────────
function hasPrebuiltBinary() {
  return fs.existsSync(destPath);
}

// ── Main ──────────────────────────────────────────────────────────
function main() {
  header('Oblivinx3x Native Addon Builder');

  console.log(`  Platform:  ${process.platform} (${process.arch})`);
  console.log(`  Node.js:   ${process.version}`);
  console.log(`  Profile:   ${profile}`);
  console.log(`  Package:   ${packageRoot}`);
  console.log(`  Workspace: ${workspaceRoot}`);
  console.log('');

  // Check if Rust is available
  const hasRust = checkRust();

  if (!hasRust) {
    console.log('');
    log('⚠', 'Rust toolchain not found.');

    if (hasPrebuiltBinary()) {
      log('✓', 'Using existing prebuilt native addon.');
      log('→', `Path: ${destPath}`);
      console.log('');
      process.exit(0);
    }

    console.log('');
    console.log('  To install Rust:');
    console.log('    Windows: https://rustup.rs/');
    console.log('    Linux/Mac: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh');
    console.log('');
    console.log('  After installing Rust, run:');
    console.log('    npm run build:addon');
    console.log('');
    process.exit(1);
  }

  // Build the Rust addon
  if (!buildRust()) {
    process.exit(1);
  }

  // Copy the artifact
  if (!copyArtifact()) {
    process.exit(1);
  }

  // Success
  header('Build Complete ✓');
  console.log(`  Native addon: ${destPath}`);
  console.log('');
  console.log('  Quick test:');
  console.log('    npm run build && node -e "const db = require(\'./dist/index.js\')"');
  console.log('');
}

main();
