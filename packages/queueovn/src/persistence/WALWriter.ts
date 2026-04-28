import * as fs from 'fs';
import * as path from 'path';

export type WALOperation =
    | 'ENQUEUE'
    | 'ACTIVATE'
    | 'COMPLETE'
    | 'FAIL'
    | 'RETRY'
    | 'EXPIRE'
    | 'DLQ'
    // feat: FlowController persistence ops
    | 'CHAIN_REGISTER'
    | 'CHAIN_ADVANCE'
    | 'CHAIN_COMPLETE'
    | 'DAG_REGISTER'
    | 'DAG_COMPLETE_DEP'
    // feat: DeadLetterQueue persistence ops
    | 'DLQ_ADD'
    | 'DLQ_REMOVE';

export interface WALEntry {
    seq: number;
    op: WALOperation;
    jobId: string;
    timestamp: number;
    data?: unknown;
}

/**
 * WALWriter — Write-Ahead Log for crash recovery.
 * Each operation is appended as a JSON line (synchronous for atomicity).
 */
export class WALWriter {
    private readonly walPath: string;
    private seq = 0;
    private enabled: boolean;
    private stream: fs.WriteStream | null = null;

    constructor(walPath: string, enabled = true) {
        this.walPath = walPath;
        this.enabled = enabled;
    }

    /**
     * Initialize: ensure directory exists & read current sequence number.
     */
    initialize(): void {
        if (!this.enabled) return;
        const dir = path.dirname(this.walPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(this.walPath)) {
            const lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter(Boolean);
            const last = lines[lines.length - 1];
            if (last) {
                try {
                    const entry = JSON.parse(last) as WALEntry;
                    this.seq = entry.seq + 1;
                } catch {
                    /* malformed last line — safe to ignore */
                }
            }
        }
        this.stream = fs.createWriteStream(this.walPath, { flags: 'a', encoding: 'utf8' });
    }

    /**
     * Append a WAL entry synchronously.
     */
    append(op: WALOperation, jobId: string, data?: unknown): WALEntry {
        const entry: WALEntry = {
            seq: this.seq++,
            op,
            jobId,
            timestamp: Date.now(),
            data,
        };
        if (this.enabled && this.stream) {
            this.stream.write(JSON.stringify(entry) + '\n');
        }
        return entry;
    }

    /**
     * Read all WAL entries from disk.
     */
    readAll(): WALEntry[] {
        if (!this.enabled || !fs.existsSync(this.walPath)) return [];
        const lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter(Boolean);
        const entries: WALEntry[] = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line) as WALEntry);
            } catch {
                /* skip corrupted line */
            }
        }
        return entries;
    }

    /**
     * Read WAL entries after a given sequence number (for post-snapshot replay).
     */
    readAfter(seq: number): WALEntry[] {
        return this.readAll().filter((e) => e.seq > seq);
    }

    /**
     * Truncate the WAL (called after snapshot is persisted).
     */
    async truncate(): Promise<void> {
        if (!this.enabled) return;
        if (this.stream) {
            await new Promise<void>((resolve) => {
                this.stream!.end(resolve);
            });
            this.stream = null;
        }
        fs.writeFileSync(this.walPath, '', 'utf8');
        this.seq = 0;
        this.stream = fs.createWriteStream(this.walPath, { flags: 'a', encoding: 'utf8' });
    }

    /**
     * Close the stream gracefully
     */
    async close(): Promise<void> {
        if (this.stream) {
            await new Promise<void>((resolve) => {
                this.stream!.end(resolve);
            });
            this.stream = null;
        }
    }

    get currentSeq(): number {
        return this.seq;
    }
}
