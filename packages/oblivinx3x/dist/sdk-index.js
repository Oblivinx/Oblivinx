/**
 * Oblivinx3x — Production-Grade TypeScript SDK
 *
 * Embedded document database with MongoDB-compatible API,
 * relational features, and Rust performance.
 *
 * @packageDocumentation
 */
export { Collection } from './collection.js';
// Transaction — satu sumber kebenaran: src/transaction.ts
// core/transaction.ts hanya re-export dari sini
export { Transaction } from './transaction.js';
// ═══════════════════════════════════════════════════════════
//  QUERY SYSTEM
// ═══════════════════════════════════════════════════════════
export { QueryBuilder, Cursor } from './query/builder.js';
// ═══════════════════════════════════════════════════════════
//  RELATIONS
// ═══════════════════════════════════════════════════════════
export { RelationManager } from './relations/index.js';
// ═══════════════════════════════════════════════════════════
//  ERRORS
// ═══════════════════════════════════════════════════════════
export { OblivinxError, DatabaseClosedError, CollectionNotFoundError, CollectionExistsError, DuplicateKeyError, TransactionAbortedError, TransactionConflictError, SavepointNotFoundError, ValidationError, QueryTimeoutError, IndexNotFoundError, IndexExistsError, NativeLoadError, NativeExecutionError, SerializationError, InvalidOperationError, NotImplementedError, CorruptDataError, mapNativeError, } from './errors/index.js';
//# sourceMappingURL=sdk-index.js.map