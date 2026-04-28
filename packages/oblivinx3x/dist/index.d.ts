/**
 * @module oblivinx3x
 *
 * Oblivinx3x — High-Performance Embedded Document Database.
 *
 * Database dokumen embedded yang dibangun di atas hybrid B+/LSM storage
 * architecture dengan MVCC concurrency control dan ACID transactions.
 * Compatible dengan MongoDB Query Language (MQL).
 *
 * ## Fitur Utama
 * - **MongoDB-compatible**: Filter, update, dan aggregation operators
 * - **ACID Transactions**: MVCC dengan Snapshot Isolation
 * - **Zero Configuration**: Single-file database, tanpa server
 * - **High Performance**: Rust engine via Neon native addon
 * - **Compression**: Built-in LZ4 dan Zstd
 * - **Full-text Search**: Inverted index dengan TF-IDF scoring
 * - **Type-safe**: Full TypeScript support dengan generic schemas
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * // Buka/buat database
 * const db = new Oblivinx3x('mydb.ovn');
 *
 * // Gunakan collection
 * const users = db.collection('users');
 *
 * // Insert
 * await users.insertOne({ name: 'Alice', age: 28, email: 'alice@example.com' });
 *
 * // Query
 * const results = await users.find({ age: { $gt: 18 } });
 *
 * // Update
 * await users.updateOne({ name: 'Alice' }, { $set: { age: 29 } });
 *
 * // Aggregation
 * const stats = await users.aggregate([
 *   { $group: { _id: '$city', count: { $sum: 1 } } },
 * ]);
 *
 * // Close
 * await db.close();
 * ```
 *
 * ## Typed Collections
 *
 * ```typescript
 * import { Oblivinx3x, Document } from 'oblivinx3x';
 *
 * interface User extends Document {
 *   name: string;
 *   age: number;
 *   email: string;
 * }
 *
 * const db = new Oblivinx3x('mydb.ovn');
 * const users = db.collection<User>('users');
 *
 * // Full type inference!
 * const alice = await users.findOne({ email: 'alice@example.com' });
 * if (alice) {
 *   console.log(alice.name); // TypeScript knows this is string
 * }
 * ```
 *
 * @packageDocumentation
 */
export { Oblivinx3x, Database, open } from './database.js';
export type { RecoveryCheckpoint } from './database.js';
export { Collection } from './collection.js';
export { Transaction } from './transaction.js';
export type { TransactionState, TransactionInfo } from './transaction.js';
export { OvnError, CollectionNotFoundError, CollectionExistsError, WriteConflictError, ValidationError, } from './errors/index.js';
export type { OvnConfig, Document, FilterQuery, ComparisonOperators, UpdateQuery, FindOptions, PipelineStage, InsertOneResult, InsertManyResult, BulkInsertOptions, UpdateResult, DeleteResult, IndexFields, IndexOptions, IndexInfo, CollationOptions, OvnMetrics, OvnVersion, ViewDefinition, MaterializedViewOptions, ViewInfo, RelationDefinition, RelationInfo, ReferentialIntegrityMode, TriggerEvent, TriggerContext, TriggerInfo, PragmaName, PragmaValue, AttachedDatabaseInfo, ExplainVerbosity, ExplainPlan, OvnMetricsExtended, VersioningConfig, VersionInfo, VersionDiffEntry, VersionDiff, DurabilityLevel, EngineInfo, WalStats, ArcCacheStats, WriteConflictRetryOptions, ConcurrentTransactionOptions, } from './types/index.js';
export { Oblivinx3x as default } from './database.js';
export { QueryBuilder, AggregateBuilder, Cursor, createCursor } from './query/builder.js';
export type { CursorOptions, QueryExecutor, ComparisonOp, ProjectionSpec, SortSpec } from './query/builder.js';
export { FilterBuilder } from './query/FilterBuilder.js';
export { UpdateBuilder } from './query/UpdateBuilder.js';
export { compileSql, sql } from './query/SqlLikeQuery.js';
export type { CompiledSQL } from './query/SqlLikeQuery.js';
export { RelationManager } from './relations/index.js';
export { safeSerialize, safeDeserialize, withRetry, generateId } from './utils/index.js';
export type { RetryOptions, IdStrategy, SnowflakeConfig } from './utils/index.js';
export { SecurityContext, createSecurityContext, checkPermission, isFieldReadable, isFieldWritable, filterDocumentByACL, sanitizeDocumentByACL, AuditLogger, InMemoryAuditLogBackend, sanitizeInput, validateDepth, validateSize, RateLimiter, QueryValidator, defaultQueryValidator, QueryError, } from './security/index.js';
export type { SecurityOptions, CollectionOperation, CollectionPermissionMap, FieldACL, AuditEvent, AuditLogBackend, InputValidationConfig, } from './security/index.js';
export { asCollectionName, asDocumentId } from './types/index.js';
export type { CollectionName, DocumentId } from './types/index.js';
export { ViewManager, TriggerManager, PragmaManager, AttachManager, BlobManager, MetricsManager, } from './db/index.js';
export type { TriggerHandler } from './db/index.js';
export { BackupManager } from './backup/BackupManager.js';
export type { BackupInfo, PrunePolicy, RestoreProgressCallback } from './backup/BackupManager.js';
export { computeDiff, applyDiff, reverseDiff, createVersionMeta, attachVersionMeta, stripVersionMeta, isVersioned, buildTimeline, VersioningConfigBuilder, } from './versioning/VersionedDocument.js';
export type { VersionMetadata, VersionedDoc, FieldDiff, DocumentDiff, TimelineEntry, } from './versioning/VersionedDocument.js';
//# sourceMappingURL=index.d.ts.map