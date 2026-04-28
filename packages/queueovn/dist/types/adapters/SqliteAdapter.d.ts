import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
interface SqliteAdapterOptions {
    /** Path to the SQLite database file */
    path: string;
}
/**
 * SqliteAdapter — persistent adapter using better-sqlite3 with WAL mode.
 * better-sqlite3 is a peerDependency; we import it dynamically so users
 * who only use MemoryAdapter aren't forced to install it.
 *
 * @example
 * import { SqliteAdapter } from 'wa-job-queue';
 * const adapter = new SqliteAdapter({ path: './jobs.db' });
 * await adapter.initialize();
 */
export declare class SqliteAdapter implements IStorageAdapter {
    private readonly dbPath;
    private db;
    constructor({ path }: SqliteAdapterOptions);
    /**
     * Initialize the database — call before using the adapter.
     * Creates the jobs table, enables WAL mode.
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
    private checkInit;
}
export {};
