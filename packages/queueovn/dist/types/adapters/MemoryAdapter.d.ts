import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
/**
 * MemoryAdapter — default in-process adapter, zero external dependencies.
 * Uses PriorityHeap internally for O(log n) priority scheduling.
 */
export declare class MemoryAdapter implements IStorageAdapter {
    private readonly heap;
    /** Holds jobs in non-pending states (active, done, failed, etc.) */
    private readonly store;
    private readonly pendingIndex;
    push<T extends JobPayload>(job: Job<T>): Promise<void>;
    pop<T extends JobPayload>(): Promise<Job<T> | null>;
    peek<T extends JobPayload>(): Promise<Job<T> | null>;
    get<T extends JobPayload>(id: string): Promise<Job<T> | null>;
    update<T extends JobPayload>(job: Job<T>): Promise<void>;
    remove(id: string): Promise<void>;
    size(): Promise<number>;
    getAll<T extends JobPayload>(): Promise<Job<T>[]>;
    clear(): Promise<void>;
    close(): Promise<void>;
}
