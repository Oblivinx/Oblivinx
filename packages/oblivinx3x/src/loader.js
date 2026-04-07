/**
 * @file Oblivinx3x Native Module Loader
 *
 * Cross-platform loader for the pre-built Neon native addon.
 * Resolution order:
 *   1. Optional platform-specific npm package (installed via optionalDependencies)
 *   2. Local release build (target/release/ovn_neon.node)
 *   3. Local debug build  (target/debug/ovn_neon.node)
 *
 * The optional packages follow the naming convention:
 *   oblivinx3x-{platform}-{arch}[-{libc}]
 *
 * Platform packages:
 *   Windows x64:   oblivinx3x-win32-x64-msvc
 *   Linux x64:     oblivinx3x-linux-x64-gnu
 *   Linux ARM64:   oblivinx3x-linux-arm64-gnu
 *   macOS x64:     oblivinx3x-darwin-x64
 *   macOS ARM64:   oblivinx3x-darwin-arm64
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Map (platform, arch) → optional dep package name
const PLATFORM_PACKAGES = {
  'win32-x64':   'oblivinx3x-win32-x64-msvc',
  'linux-x64':   'oblivinx3x-linux-x64-gnu',
  'linux-arm64': 'oblivinx3x-linux-arm64-gnu',
  'darwin-x64':  'oblivinx3x-darwin-x64',
  'darwin-arm64':'oblivinx3x-darwin-arm64',
};

// Map platform → native file extensions to try when falling back to local build
const NATIVE_EXTENSIONS = {
  win32:  ['ovn_neon.dll', 'ovn_neon.node'],
  linux:  ['ovn_neon.node', 'libovn_neon.so'],
  darwin: ['ovn_neon.node', 'libovn_neon.dylib'],
};

/**
 * Attempt to load the native addon from an optional platform package.
 * Returns the native module or null if not available.
 */
function tryLoadPlatformPackage() {
  const key = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGES[key];
  if (!pkgName) return null;

  try {
    return require(pkgName);
  } catch {
    return null;
  }
}

/**
 * Attempt to load the native addon from a local build directory.
 * Tries release first, then debug.
 */
function tryLoadLocalBuild() {
  // Walk up from this file to find the workspace root (where Cargo.toml is)
  // packages/oblivinx3x/src/loader.js → ../../../ = workspace root
  const workspaceRoot = resolve(__dirname, '..', '..', '..');
  const extensions = NATIVE_EXTENSIONS[process.platform] || ['ovn_neon.node'];

  for (const profile of ['release', 'debug']) {
    for (const ext of extensions) {
      const candidate = join(workspaceRoot, 'target', profile, ext);
      if (existsSync(candidate)) {
        try {
          return require(candidate);
        } catch {
          continue;
        }
      }
    }
  }

  return null;
}

/**
 * Load the Oblivinx3x native module.
 * @throws {Error} with actionable build instructions if native module not found.
 */
function loadNative() {
  // 1. Try optional platform npm package (production path)
  const fromPkg = tryLoadPlatformPackage();
  if (fromPkg) return fromPkg;

  // 2. Try local build (development path)
  const fromLocal = tryLoadLocalBuild();
  if (fromLocal) return fromLocal;

  // 3. Fail with helpful error message
  const platform = `${process.platform}-${process.arch}`;
  const supported = Object.keys(PLATFORM_PACKAGES).join(', ');

  throw new Error(
    [
      `[Oblivinx3x] Failed to load native addon for platform: ${platform}`,
      '',
      'To fix this, either:',
      '',
      '  Option 1 — Build from source (requires Rust):',
      '    Windows: .\\scripts\\build.ps1',
      '    Linux/macOS: ./scripts/build.sh',
      '',
      '  Option 2 — Install a supported platform package:',
      `    Supported: ${supported}`,
      '',
      '  Option 3 — Install from npm (pre-built binaries):',
      '    npm install oblivinx3x',
      '',
    ].join('\n')
  );
}

export const native = loadNative();
export default native;
