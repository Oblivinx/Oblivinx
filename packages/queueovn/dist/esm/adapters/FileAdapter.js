import * as fs from 'fs';
import * as path from 'path';
import { AdapterError } from '../errors/AdapterError.js';
/**
 * FileAdapter — JSON flat-file adapter.
 * Great for dev, CLI tools, or small-scale deployments.
 * NOT suitable for high-concurrency production use.
 */
export class FileAdapter {
    filePath;
    store = { jobs: {} };
    constructor({ filePath }) {
        this.filePath = filePath;
    }
    /**
     * Load the file store from disk (call on startup).
     */
    async initialize() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                this.store = JSON.parse(raw);
            }
            else {
                this.store = { jobs: {} };
                await this.flush();
            }
        }
        catch (err) {
            throw new AdapterError(`FileAdapter: failed to initialize from ${this.filePath}`, err);
        }
    }
    async push(job) {
        this.store.jobs[job.id] = job;
        await this.flush();
    }
    async pop() {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => {
            if (a.priority !== b.priority)
                return a.priority - b.priority;
            if (a.runAt !== b.runAt)
                return a.runAt - b.runAt;
            return a.createdAt - b.createdAt;
        });
        if (ready.length === 0)
            return null;
        const job = ready[0];
        delete this.store.jobs[job.id];
        await this.flush();
        return job;
    }
    async peek() {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => a.priority - b.priority);
        return ready.length > 0 ? ready[0] : null;
    }
    async get(id) {
        return this.store.jobs[id] ?? null;
    }
    async update(job) {
        this.store.jobs[job.id] = job;
        await this.flush();
    }
    async remove(id) {
        delete this.store.jobs[id];
        await this.flush();
    }
    async size() {
        const now = Date.now();
        return Object.values(this.store.jobs).filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now).length;
    }
    async getAll() {
        return Object.values(this.store.jobs);
    }
    async clear() {
        this.store = { jobs: {} };
        await this.flush();
    }
    async close() {
        await this.flush();
    }
    async flush() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf8');
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            throw new AdapterError(`FileAdapter: failed to flush to ${this.filePath}`, err);
        }
    }
}
