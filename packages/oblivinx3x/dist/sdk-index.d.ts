/**
 * Oblivinx3x — Production-Grade TypeScript SDK
 *
 * Embedded document database with MongoDB-compatible API,
 * relational features, and Rust performance.
 *
 * @packageDocumentation
 */
export type { OblivinxDB } from './core/database.js';
export { Collection } from './collection.js';
export { Transaction } from './transaction.js';
export type { TransactionState, TransactionInfo } from './transaction.js';
export { QueryBuilder, Cursor } from './query/builder.js';
export type { CursorOptions } from './query/builder.js';
export { RelationManager } from './relations/index.js';
export type { RelationDefinition, RelationType, FKValidationMode, CascadeBehavior, } from './relations/index.js';
export type { Document, FilterQuery, UpdateQuery, FindOptions, PipelineStage, IndexFields, IndexOptions, IndexInfo, InsertOneResult, InsertManyResult, UpdateResult, DeleteResult, OvnConfig, OvnMetrics, OvnVersion, CollectionOptions, TimeSeriesOptions, } from './types/index.js';
export { OblivinxError, DatabaseClosedError, CollectionNotFoundError, CollectionExistsError, DuplicateKeyError, TransactionAbortedError, TransactionConflictError, SavepointNotFoundError, ValidationError, QueryTimeoutError, IndexNotFoundError, IndexExistsError, NativeLoadError, NativeExecutionError, SerializationError, InvalidOperationError, NotImplementedError, CorruptDataError, mapNativeError, } from './errors/index.js';
export type { OblivinxErrorCode } from './errors/index.js';
//# sourceMappingURL=sdk-index.d.ts.map