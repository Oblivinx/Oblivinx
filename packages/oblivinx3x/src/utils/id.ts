/**
 * @module utils/id
 *
 * ID generation utilities supporting multiple strategies.
 *
 * @packageDocumentation
 */

/** Supported ID generation strategies */
export type IdStrategy = 'uuid' | 'snowflake' | 'increment';

/** Snowflake ID configuration */
export interface SnowflakeConfig {
  workerId: number;
  datacenterId: number;
}

/** Snowflake ID generator state */
interface SnowflakeState {
  workerId: number;
  datacenterId: number;
  lastTimestamp: number;
  sequence: number;
}

/** Auto-increment state (module-level) */
const incrementState: Map<string, number> = new Map();

/** Snowflake state (module-level singleton) */
let snowflakeState: SnowflakeState | null = null;

// Snowflake constants
const EPOCH = 1704067200000n; // 2024-01-01 00:00:00 UTC in milliseconds
const WORKER_ID_BITS = 5n;
const DATACENTER_ID_BITS = 5n;
const SEQUENCE_BITS = 12n;

const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n;
const MAX_DATACENTER_ID = (1n << DATACENTER_ID_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

const WORKER_ID_SHIFT = DATACENTER_ID_BITS + SEQUENCE_BITS;
const DATACENTER_ID_SHIFT = SEQUENCE_BITS;

/**
 * Generate a new ID using the specified strategy.
 *
 * @param strategy - ID generation strategy
 * @param config - Optional configuration (required for snowflake)
 * @param collection - Collection name (used for increment strategy)
 * @returns Generated ID string
 */
export function generateId(
  strategy: IdStrategy = 'uuid',
  config?: { snowflake?: SnowflakeConfig; collection?: string },
): string {
  switch (strategy) {
    case 'uuid':
      return generateUuid();
    case 'snowflake':
      if (!config?.snowflake) {
        throw new Error('Snowflake config required');
      }
      return generateSnowflake(config.snowflake);
    case 'increment':
      if (!config?.collection) {
        throw new Error('Collection name required for increment strategy');
      }
      return generateIncrement(config.collection);
    default:
      throw new Error(`Unknown ID strategy: ${strategy}`);
  }
}

/**
 * Generate a UUID v4 string (fallback implementation).
 * Uses crypto.getRandomValues if available, otherwise Math.random.
 */
function generateUuid(): string {
  // Use native crypto if available
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  // Fallback: generate UUID v4 using Math.random
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a Snowflake ID.
 *
 * Format (64-bit):
 * - 41 bits: timestamp (milliseconds since epoch)
 * - 5 bits: datacenter ID
 * - 5 bits: worker ID
 * - 12 bits: sequence number
 *
 * Returns string to avoid precision loss in JavaScript.
 */
function generateSnowflake(config: SnowflakeConfig): string {
  // Validate config
  if (config.workerId < 0 || config.workerId > Number(MAX_WORKER_ID)) {
    throw new Error(
      `Worker ID must be between 0 and ${Number(MAX_WORKER_ID)}, got ${config.workerId}`,
    );
  }
  if (
    config.datacenterId < 0 ||
    config.datacenterId > Number(MAX_DATACENTER_ID)
  ) {
    throw new Error(
      `Datacenter ID must be between 0 and ${Number(MAX_DATACENTER_ID)}, got ${config.datacenterId}`,
    );
  }

  // Initialize snowflake state on first call
  if (!snowflakeState) {
    snowflakeState = {
      workerId: config.workerId,
      datacenterId: config.datacenterId,
      lastTimestamp: -1,
      sequence: 0,
    };
  }

  const now = Date.now();

  if (now < snowflakeState.lastTimestamp) {
    throw new Error(
      `Clock moved backwards. Refusing to generate ID for ${snowflakeState.lastTimestamp - now}ms`,
    );
  }

  if (now === snowflakeState.lastTimestamp) {
    snowflakeState.sequence =
      (snowflakeState.sequence + 1) & Number(MAX_SEQUENCE);
    if (snowflakeState.sequence === 0) {
      // Wait for next millisecond
      snowflakeState.lastTimestamp = waitNextMillis(snowflakeState.lastTimestamp);
    }
  } else {
    snowflakeState.sequence = 0;
  }

  snowflakeState.lastTimestamp = now;

  // Construct the snowflake ID
  const timestamp = BigInt(now) - EPOCH;
  const workerId = BigInt(config.workerId);
  const datacenterId = BigInt(config.datacenterId);
  const sequence = BigInt(snowflakeState.sequence);

  const id =
    (timestamp << (WORKER_ID_SHIFT + DATACENTER_ID_SHIFT + SEQUENCE_BITS)) |
    (datacenterId << (DATACENTER_ID_SHIFT + SEQUENCE_BITS)) |
    (workerId << SEQUENCE_BITS) |
    sequence;

  return id.toString();
}

/** Wait until the next millisecond */
function waitNextMillis(lastTimestamp: number): number {
  let timestamp = Date.now();
  while (timestamp <= lastTimestamp) {
    timestamp = Date.now();
  }
  return timestamp;
}

/**
 * Generate an auto-increment ID for a collection.
 * Thread-safe within a single process.
 */
function generateIncrement(collection: string): string {
  const current = incrementState.get(collection) ?? 0;
  const next = current + 1;
  incrementState.set(collection, next);
  return next.toString();
}

/**
 * Reset the increment counter for a collection (useful for testing).
 */
export function resetIncrement(collection: string): void {
  incrementState.delete(collection);
}

/**
 * Reset all increment counters (useful for testing).
 */
export function resetAllIncrements(): void {
  incrementState.clear();
}
