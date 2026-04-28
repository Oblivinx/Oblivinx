import type { QueueConfig } from '../types/queue.types.js';
/**
 * Runtime validation of QueueConfig.
 * Uses plain checks (no zod dependency required for runtime).
 * Zod can be used in user-land for schema docs if desired.
 *
 * @throws QueueError if config is invalid
 */
export declare function validateConfig(config: QueueConfig): void;
