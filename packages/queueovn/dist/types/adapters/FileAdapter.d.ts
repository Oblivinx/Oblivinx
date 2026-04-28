import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
export interface FileAdapterOptions {
    /** Path to the JSON db file (e.g. './jobs.json') */
    filePath: string;
}
/**
 * FileAdapter — JSON flat-file adapter.
 * Great for dev, CLI tools, or small-scale deployments.
 * NOT suitable for high-concurrency production use.
 */
export declare class FileAdapter implements IStorageAdapter {
    private readonly filePath;
    private store;
    constructor({ filePath }: FileAdapterOptions);
    /**
     * Load the file store from disk (call on startup).
     */
    initialize(): Promise<void>;
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
    private flush;
}
