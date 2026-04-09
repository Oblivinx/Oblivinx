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
import type { NativeAddon } from './types/index.js';
/**
 * Native addon instance yang sudah dimuat dan siap digunakan.
 *
 * Instance ini di-load sekali saat module pertama kali di-import,
 * dan di-reuse untuk semua operasi berikutnya (module caching).
 *
 * @internal — Tidak di-export ke public API consumer.
 */
export declare const native: NativeAddon;
//# sourceMappingURL=loader.d.ts.map