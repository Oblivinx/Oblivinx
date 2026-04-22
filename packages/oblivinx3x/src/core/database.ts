/**
 * @file core/database.ts
 * @module oblivinx3x/core
 * @description
 *   Re-export `Oblivinx3x` sebagai `OblivinxDB` type alias.
 *
 *   File ini menjaga kompatibilitas modul internal yang import
 *   dari path `core/database` tanpa perlu mengubah semua import.
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */

export type { Oblivinx3x as OblivinxDB } from '../database.js';
