/**
 * @module errors
 * 
 * Structured error hierarchy for Oblivinx3x.
 * 
 * All native errors are mapped to typed TypeScript error classes
 * with error codes, messages, and optional metadata.
 * 
 * @packageDocumentation
 */

/** Base error code for all Oblivinx3x errors */
export type OblivinxErrorCode =
  | 'ERR_DATABASE_CLOSED'
  | 'ERR_COLLECTION_NOT_FOUND'
  | 'ERR_COLLECTION_EXISTS'
  | 'ERR_DUPLICATE_KEY'
  | 'ERR_TRANSACTION_ABORTED'
  | 'ERR_TRANSACTION_CONFLICT'
  | 'ERR_INVALID_SCHEMA'
  | 'ERR_QUERY_TIMEOUT'
  | 'ERR_INDEX_NOT_FOUND'
  | 'ERR_INDEX_EXISTS'
  | 'ERR_NATIVE_LOAD_FAILED'
  | 'ERR_NATIVE_EXECUTION'
  | 'ERR_SERIALIZATION'
  | 'ERR_INVALID_OPERATION'
  | 'ERR_NOT_IMPLEMENTED'
  | 'ERR_CORRUPT_DATA'
  | 'ERR_SAVEPOINT_NOT_FOUND'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_RATE_LIMITED'
  | 'ERR_INPUT_TOO_DEEP'
  | 'ERR_INPUT_TOO_LARGE'
  | 'ERR_SAVEPOINT_EXISTS';

/** Base error class for all Oblivinx3x errors */
export class OblivinxError extends Error {
  /** Error code for programmatic handling */
  readonly code: OblivinxErrorCode;
  /** Additional metadata about the error */
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: OblivinxErrorCode,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OblivinxError';
    this.code = code;
    this.metadata = metadata;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when attempting operations on a closed database */
export class DatabaseClosedError extends OblivinxError {
  constructor(path: string) {
    super(
      'ERR_DATABASE_CLOSED',
      `Database is closed: ${path}`,
      { path },
    );
    this.name = 'DatabaseClosedError';
  }
}

/** Thrown when a collection does not exist */
export class CollectionNotFoundError extends OblivinxError {
  constructor(name: string) {
    super(
      'ERR_COLLECTION_NOT_FOUND',
      `Collection not found: ${name}`,
      { collection: name },
    );
    this.name = 'CollectionNotFoundError';
  }
}

/** Thrown when attempting to create a collection that already exists */
export class CollectionExistsError extends OblivinxError {
  constructor(name: string) {
    super(
      'ERR_COLLECTION_EXISTS',
      `Collection already exists: ${name}`,
      { collection: name },
    );
    this.name = 'CollectionExistsError';
  }
}

/** Thrown when a unique constraint is violated */
export class DuplicateKeyError extends OblivinxError {
  readonly keyValue: Record<string, unknown>;

  constructor(keyValue: Record<string, unknown>) {
    super(
      'ERR_DUPLICATE_KEY',
      `Duplicate key error: ${JSON.stringify(keyValue)}`,
      { keyValue },
    );
    this.name = 'DuplicateKeyError';
    this.keyValue = keyValue;
  }
}

/** Thrown when a transaction is aborted */
export class TransactionAbortedError extends OblivinxError {
  constructor(txid?: string) {
    super(
      'ERR_TRANSACTION_ABORTED',
      `Transaction was aborted${txid ? ` (txid: ${txid})` : ''}`,
      { txid },
    );
    this.name = 'TransactionAbortedError';
  }
}

/** Thrown when a transaction conflict is detected */
export class TransactionConflictError extends OblivinxError {
  constructor(message: string = 'Transaction conflict detected') {
    super(
      'ERR_TRANSACTION_CONFLICT',
      message,
    );
    this.name = 'TransactionConflictError';
  }
}

/** Thrown when a savepoint does not exist */
export class SavepointNotFoundError extends OblivinxError {
  constructor(savepoint: string) {
    super(
      'ERR_SAVEPOINT_NOT_FOUND',
      `Savepoint not found: ${savepoint}`,
      { savepoint },
    );
    this.name = 'SavepointNotFoundError';
  }
}

/** Thrown when document validation fails */
export class ValidationError extends OblivinxError {
  readonly document?: Record<string, unknown>;
  readonly violations?: string[];

  constructor(
    message: string,
    document?: Record<string, unknown>,
    violations?: string[],
  ) {
    super(
      'ERR_INVALID_SCHEMA',
      message,
      { document, violations },
    );
    this.name = 'ValidationError';
    this.document = document;
    this.violations = violations;
  }
}

/** Thrown when a query exceeds the timeout */
export class QueryTimeoutError extends OblivinxError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      'ERR_QUERY_TIMEOUT',
      `Query exceeded timeout of ${timeoutMs}ms`,
      { timeoutMs },
    );
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when an index is not found */
export class IndexNotFoundError extends OblivinxError {
  constructor(index: string, collection: string) {
    super(
      'ERR_INDEX_NOT_FOUND',
      `Index '${index}' not found on collection '${collection}'`,
      { index, collection },
    );
    this.name = 'IndexNotFoundError';
  }
}

/** Thrown when attempting to create an index that already exists */
export class IndexExistsError extends OblivinxError {
  constructor(index: string, collection: string) {
    super(
      'ERR_INDEX_EXISTS',
      `Index '${index}' already exists on collection '${collection}'`,
      { index, collection },
    );
    this.name = 'IndexExistsError';
  }
}

/** Thrown when native module fails to load */
export class NativeLoadError extends OblivinxError {
  constructor(message: string, originalError?: unknown) {
    super(
      'ERR_NATIVE_LOAD_FAILED',
      message,
      { originalError: originalError ? String(originalError) : undefined },
    );
    this.name = 'NativeLoadError';
  }
}

/** Thrown when native operation fails */
export class NativeExecutionError extends OblivinxError {
  readonly originalMessage: string;

  constructor(originalMessage: string) {
    super(
      'ERR_NATIVE_EXECUTION',
      `Native execution failed: ${originalMessage}`,
      { originalMessage },
    );
    this.name = 'NativeExecutionError';
    this.originalMessage = originalMessage;
  }
}

/** Thrown when serialization fails */
export class SerializationError extends OblivinxError {
  constructor(message: string) {
    super('ERR_SERIALIZATION', message);
    this.name = 'SerializationError';
  }
}

/** Thrown when an operation is not supported */
export class InvalidOperationError extends OblivinxError {
  constructor(message: string) {
    super('ERR_INVALID_OPERATION', message);
    this.name = 'InvalidOperationError';
  }
}

/** Thrown when a feature is not yet implemented */
export class NotImplementedError extends OblivinxError {
  constructor(feature: string) {
    super(
      'ERR_NOT_IMPLEMENTED',
      `Feature not implemented: ${feature}`,
      { feature },
    );
    this.name = 'NotImplementedError';
  }
}

/** Thrown when data corruption is detected */
export class CorruptDataError extends OblivinxError {
  constructor(location: string) {
    super(
      'ERR_CORRUPT_DATA',
      `Corrupt data detected at: ${location}`,
      { location },
    );
    this.name = 'CorruptDataError';
  }
}

/** Thrown when a savepoint name conflicts with an existing one */
export class SavepointExistsError extends OblivinxError {
  constructor(savepoint: string) {
    super(
      'ERR_SAVEPOINT_EXISTS',
      `Savepoint already exists: ${savepoint}`,
      { savepoint },
    );
    this.name = 'SavepointExistsError';
  }
}

/** Thrown when an operation is denied due to insufficient permissions */
export class PermissionDeniedError extends OblivinxError {
  constructor(operation: string, resource: string) {
    super(
      'ERR_PERMISSION_DENIED',
      `Permission denied: '${operation}' on '${resource}'`,
      { operation, resource },
    );
    this.name = 'PermissionDeniedError';
  }
}

/** Thrown when a rate limit is exceeded */
export class RateLimitedError extends OblivinxError {
  constructor(collection: string, operation: string) {
    super(
      'ERR_RATE_LIMITED',
      `Rate limit exceeded: '${operation}' on collection '${collection}'`,
      { collection, operation },
    );
    this.name = 'RateLimitedError';
  }
}

/** Thrown when input document nesting depth exceeds the limit */
export class InputDepthError extends OblivinxError {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(
      'ERR_INPUT_TOO_DEEP',
      `Document nesting depth exceeds maximum of ${maxDepth}`,
      { maxDepth },
    );
    this.name = 'InputDepthError';
    this.maxDepth = maxDepth;
  }
}

/** Thrown when input document size exceeds the limit */
export class InputSizeError extends OblivinxError {
  readonly maxSize: number;
  readonly actualSize: number;

  constructor(maxSize: number, actualSize: number) {
    super(
      'ERR_INPUT_TOO_LARGE',
      `Document size ${actualSize} bytes exceeds maximum of ${maxSize} bytes`,
      { maxSize, actualSize },
    );
    this.name = 'InputSizeError';
    this.maxSize = maxSize;
    this.actualSize = actualSize;
  }
}

/**
 * Map native error strings to appropriate TypeScript error classes.
 * Uses regex pattern matching for more robust error classification.
 * @internal
 */
export function mapNativeError(message: string): OblivinxError {
  const ERROR_PATTERNS: Array<[RegExp, (m: string) => OblivinxError]> = [
    [/collection.*not found/i, (m) => new CollectionNotFoundError(m)],
    [/already exists.*collection/i, (m) => new CollectionExistsError(m)],
    [/duplicate key/i, (m) => new DuplicateKeyError({ error: m })],
    [/write conflict/i, (m) => new TransactionConflictError(m)],
    [/closed/i, (m) => new DatabaseClosedError(m)],
    [/savepoint.*not found/i, (m) => new SavepointNotFoundError(m)],
    [/savepoint.*already exists/i, (m) => new SavepointExistsError(m)],
    [/permission denied/i, (m) => new PermissionDeniedError(m, '')],
    [/rate limit/i, (m) => new RateLimitedError('', m)],
    [/depth/i, (_m) => new InputDepthError(20)],
    [/size.*exceeds/i, (_m) => new InputSizeError(16 * 1024 * 1024, 0)],
    [/corrupt/i, (m) => new CorruptDataError(m)],
    [/timeout/i, (_m) => new QueryTimeoutError(30000)],
    [/index.*not found/i, (m) => new IndexNotFoundError(m, '')],
    [/index.*already exists/i, (m) => new IndexExistsError(m, '')],
    [/transaction.*abort/i, (_m) => new TransactionAbortedError()],
    [/validation/i, (m) => new ValidationError(m)],
  ];

  for (const [pattern, factory] of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return factory(message);
    }
  }

  // Fallback
  return new NativeExecutionError(message);
}

// ─── Compatibility Aliases ────────────────────────────────────────────────────

/**
 * Alias for OblivinxError — kept for backward-compatibility.
 * @deprecated Use OblivinxError instead.
 */
export { OblivinxError as OvnError };

/**
 * Alias for TransactionConflictError — kept for backward-compatibility.
 * @deprecated Use TransactionConflictError instead.
 */
export { TransactionConflictError as WriteConflictError };

// Re-export wrapNative from the wrap module so callers can use a single import path
export { wrapNative, wrapNativeAsync } from './wrap.js';
