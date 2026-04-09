/**
 * Oblivinx3x — Production-Grade TypeScript SDK
 * 
 * Embedded document database with MongoDB-compatible API,
 * relational features, and Rust performance.
 * 
 * @packageDocumentation
 */

// ═══════════════════════════════════════════════════════════
//  CORE CLASSES
// ═══════════════════════════════════════════════════════════

export type { OblivinxDB } from './core/database.js';
export { Collection } from './collection.js';
export { Transaction } from './core/transaction.js';

// ═══════════════════════════════════════════════════════════
//  QUERY SYSTEM
// ═══════════════════════════════════════════════════════════

export { QueryBuilder, Cursor } from './query/builder.js';
export type { CursorOptions } from './query/builder.js';

// ═══════════════════════════════════════════════════════════
//  RELATIONS
// ═══════════════════════════════════════════════════════════

export { RelationManager } from './relations/index.js';
export type {
  RelationDefinition,
  RelationType,
  FKValidationMode,
  CascadeBehavior,
} from './relations/index.js';

// ═══════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════

export type {
  Document,
  FilterQuery,
  UpdateQuery,
  FindOptions,
  PipelineStage,
  IndexFields,
  IndexOptions,
  IndexInfo,
  InsertOneResult,
  InsertManyResult,
  UpdateResult,
  DeleteResult,
  OvnConfig,
  OvnMetrics,
  OvnVersion,
  CollectionOptions,
  TimeSeriesOptions,
} from './types/index.js';

// ═══════════════════════════════════════════════════════════
//  ERRORS
// ═══════════════════════════════════════════════════════════

export {
  OblivinxError,
  DatabaseClosedError,
  CollectionNotFoundError,
  CollectionExistsError,
  DuplicateKeyError,
  TransactionAbortedError,
  TransactionConflictError,
  SavepointNotFoundError,
  ValidationError,
  QueryTimeoutError,
  IndexNotFoundError,
  IndexExistsError,
  NativeLoadError,
  NativeExecutionError,
  SerializationError,
  InvalidOperationError,
  NotImplementedError,
  CorruptDataError,
  mapNativeError,
} from './errors/index.js';

export type { OblivinxErrorCode } from './errors/index.js';
