/**
 * @module core/transaction
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-Export: Transaction
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * File ini adalah re-export tipis dari `../transaction.ts`.
 *
 * **Satu sumber kebenaran:**
 * Seluruh implementasi Transaction ada di `src/transaction.ts`.
 * File ini hanya agar modul internal yang import dari path `core/transaction`
 * tidak perlu diubah satu per satu.
 *
 * @see {@link ../transaction.ts} — implementasi lengkap
 *
 * @packageDocumentation
 */

// Re-export kelas, type, dan interface dari sumber tunggal
export {
  Transaction,
  type TransactionState,
  type TransactionInfo,
} from '../transaction.js';
