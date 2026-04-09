/**
 * @module loader
 *
 * Oblivinx3x Native Module Loader — Native Only.
 *
 * Loader sederhana yang hanya membaca dari `native/ovn_neon.node`.
 * File `.node` harus dikompilasi terlebih dahulu dari crate `ovn-neon`
 * dan di-copy ke direktori `native/` sebelum library bisa digunakan.
 *
 * Build workflow:
 *   1. `cargo build --release -p ovn-neon`
 *   2. Copy `target/release/ovn_neon.dll` → rename ke `ovn_neon.node`
 *   3. Copy ke `packages/oblivinx3x/native/ovn_neon.node`
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve __dirname untuk ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// createRequire diperlukan karena .node files hanya bisa di-load via require()
const require = createRequire(import.meta.url);
// ═══════════════════════════════════════════════════════════════════
//  NATIVE LOADER
// ═══════════════════════════════════════════════════════════════════
/**
 * Load native addon dari `native/ovn_neon.node`.
 *
 * Path resolution: `dist/loader.js` → naik 1 level ke package root
 * → `native/ovn_neon.node`
 *
 * @returns NativeAddon jika berhasil dimuat
 * @throws {Error} Jika file native tidak ditemukan atau gagal dimuat
 */
function loadNative() {
    // Dari dist/loader.js, naik 1 level ke package root
    const packageRoot = resolve(__dirname, '..');
    const nativePath = join(packageRoot, 'native', 'ovn_neon.node');
    if (!existsSync(nativePath)) {
        throw new Error([
            `[Oblivinx3x] Native addon tidak ditemukan: ${nativePath}`,
            '',
            'Pastikan sudah build Rust dan copy hasilnya:',
            '  1. cargo build --release -p ovn-neon',
            '  2. Copy target/release/ovn_neon.dll → rename ke ovn_neon.node',
            '  3. Copy ke packages/oblivinx3x/native/ovn_neon.node',
            '',
            'Atau jalankan script build yang tersedia:',
            '  Windows:   npm run build:rust (dari packages/oblivinx3x)',
            '',
        ].join('\n'));
    }
    try {
        return require(nativePath);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error([
            `[Oblivinx3x] Gagal memuat native addon dari: ${nativePath}`,
            `Error: ${message}`,
            '',
            'Kemungkinan penyebab:',
            '  - File .node corrupt atau tidak kompatibel',
            '  - Node.js version mismatch dengan versi saat build',
            '  - Architecture mismatch (x64 vs arm64)',
            '',
        ].join('\n'));
    }
}
/**
 * Native addon instance yang sudah dimuat dan siap digunakan.
 *
 * Instance ini di-load sekali saat module pertama kali di-import,
 * dan di-reuse untuk semua operasi berikutnya (module caching).
 *
 * @internal — Tidak di-export ke public API consumer.
 */
export const native = loadNative();
//# sourceMappingURL=loader.js.map