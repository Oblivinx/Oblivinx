import * as fs from 'fs';
import * as path from 'path';
import type { Job, JobPayload } from '../types/job.types.js';
import type { IStorageAdapter } from '../types/adapter.types.js';

export interface SnapshotData {
    seq: number;
    timestamp: number;
    jobs: Job<JobPayload>[];
}

/**
 * Snapshot — periodic full state persistence.
 * Uses atomic rename (write to .tmp then rename) for crash-safety.
 */
export class Snapshot {
    private readonly snapshotPath: string;
    private readonly adapter: IStorageAdapter;
    private timerId?: ReturnType<typeof setInterval>;
    private lastSeq = -1;

    constructor(snapshotPath: string, adapter: IStorageAdapter) {
        this.snapshotPath = snapshotPath;
        this.adapter = adapter;
    }

    /**
     * Write a snapshot immediately.
     * @param seq - The WAL sequence number at the time of snapshot
     */
    // fix: replaced fs.writeFileSync + fs.renameSync with async variants to avoid event loop blocking
    async write(seq: number): Promise<void> {
        const jobs = await this.adapter.getAll();
        const data: SnapshotData = { seq, timestamp: Date.now(), jobs };
        const dir = path.dirname(this.snapshotPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.snapshotPath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tmp, this.snapshotPath);
        this.lastSeq = seq;
    }

    /**
     * Read the latest snapshot from disk.
     * Returns null if no snapshot exists.
     */
    read(): SnapshotData | null {
        if (!fs.existsSync(this.snapshotPath)) return null;
        try {
            const raw = fs.readFileSync(this.snapshotPath, 'utf8');
            return JSON.parse(raw) as SnapshotData;
        } catch {
            return null;
        }
    }

    /**
     * Start periodic snapshot schedule.
     * @param onError - Optional callback to surface snapshot errors (e.g. emit QueueEvent.ERROR)
     */
    // fix: onError callback added so snapshot failures are no longer silently swallowed
    schedule(
        intervalMs: number,
        getSeq: () => number,
        onSuccess?: () => void | Promise<void>,
        onError?: (err: Error) => void,
    ): void {
        if (this.timerId !== undefined) return;
        this.timerId = setInterval(() => {
            this.write(getSeq())
                .then(() => onSuccess?.())
                .catch((err: unknown) => {
                    // fix: surface error instead of catch(() => {}) silent swallow
                    onError?.(err instanceof Error ? err : new Error(String(err)));
                });
        }, intervalMs);
    }

    /** Stop the periodic snapshot timer */
    stop(): void {
        if (this.timerId !== undefined) {
            clearInterval(this.timerId);
            this.timerId = undefined;
        }
    }

    get lastSnapshotSeq(): number {
        return this.lastSeq;
    }
}
