#!/usr/bin/env node
/**
 * Platform-aware build launcher.
 * Detects the current OS and runs the appropriate build script.
 *
 * Usage: node scripts/detect-platform.js [--debug]
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isDebug = process.argv.includes('--debug');

const platform = process.platform;

console.log(`\n  🔧 Oblivinx3x Build Launcher`);
console.log(`  Platform: ${platform} (${process.arch})`);
console.log(`  Profile:  ${isDebug ? 'debug' : 'release'}\n`);

try {
  if (platform === 'win32') {
    const debugFlag = isDebug ? ' -Debug' : '';
    execSync(`powershell -ExecutionPolicy Bypass -File scripts\\build.ps1${debugFlag}`, {
      cwd: root,
      stdio: 'inherit',
    });
  } else {
    const debugFlag = isDebug ? ' --debug' : '';
    execSync(`bash scripts/build.sh${debugFlag}`, {
      cwd: root,
      stdio: 'inherit',
    });
  }
} catch (err) {
  console.error('\n  ✗ Build failed:', err.message);
  process.exit(1);
}
