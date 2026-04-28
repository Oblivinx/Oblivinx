import * as fs from 'fs';
import * as path from 'path';
import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import { AdapterError } from '../errors/AdapterError.js';

export interface FileAdapterOptions {
    /** Path to the JSON db file (e.g. './jobs.json') */
    filePath: string;
}

interface FileStore {
    jobs: Record<string, Job<JobPayload>>;
}

/**
 * FileAdapter — JSON flat-file adapter.
 * Great for dev, CLI tools, or small-scale deployments.
 * NOT suitable for high-concurrency production use.
 */
export class FileAdapter implements IStorageAdapter {
    private readonly filePath: string;
    private store: FileStore = { jobs: {} };

    constructor({ filePath }: FileAdapterOptions) {
        this.filePath = filePath;
    }

    /**
     * Load the file store from disk (call on startup).
     */
    async initialize(): Promise<void> {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                this.store = JSON.parse(raw) as FileStore;
            } else {
                this.store = { jobs: {} };
                await this.flush();
            }
        } catch (err) {
            throw new AdapterError(`FileAdapter: failed to initialize from ${this.filePath}`, err);
        }
    }

    async push<T extends JobPayload>(job: Job<T>): Promise<void> {
        this.store.jobs[job.id] = job as Job<JobPayload>;
        await this.flush();
    }

    async pop<T extends JobPayload>(): Promise<Job<T> | null> {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                if (a.runAt !== b.runAt) return a.runAt - b.runAt;
                return a.createdAt - b.createdAt;
            });

        if (ready.length === 0) return null;
        const job = ready[0]!;
        delete this.store.jobs[job.id];
        await this.flush();
        return job as Job<T>;
    }

    async peek<T extends JobPayload>(): Promise<Job<T> | null> {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => a.priority - b.priority);
        return ready.length > 0 ? (ready[0]! as Job<T>) : null;
    }

    async get<T extends JobPayload>(id: string): Promise<Job<T> | null> {
        return (this.store.jobs[id] as Job<T>) ?? null;
    }

    async update<T extends JobPayload>(job: Job<T>): Promise<void> {
        this.store.jobs[job.id] = job as Job<JobPayload>;
        await this.flush();
    }

    async remove(id: string): Promise<void> {
        delete this.store.jobs[id];
        await this.flush();
    }

    async size(): Promise<number> {
        const now = Date.now();
        return Object.values(this.store.jobs).filter(
            (j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now,
        ).length;
    }

    async getAll<T extends JobPayload>(): Promise<Job<T>[]> {
        return Object.values(this.store.jobs) as Job<T>[];
    }

    async clear(): Promise<void> {
        this.store = { jobs: {} };
        await this.flush();
    }

    async close(): Promise<void> {
        await this.flush();
    }

    private async flush(): Promise<void> {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf8');
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            throw new AdapterError(`FileAdapter: failed to flush to ${this.filePath}`, err);
        }
    }
}
