import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WALWriter } from '../../../src/persistence/WALWriter.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wal-test-'));
}

describe('WALWriter', () => {
    let tmpDir: string;
    let walPath: string;

    let activeWals: WALWriter[] = [];

    beforeEach(() => {
        vi.useRealTimers();
        tmpDir = makeTempDir();
        walPath = path.join(tmpDir, 'test.wal');
        activeWals = [];
    });

    afterEach(async () => {
        for (const wal of activeWals) {
            await wal.close();
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createWal(p: string, enabled = true) {
        const wal = new WALWriter(p, enabled);
        activeWals.push(wal);
        return wal;
    }

    it('appends entries and reads them back', async () => {
        const wal = createWal(walPath);
        wal.initialize();
        wal.append('ENQUEUE', 'job-1', { foo: 'bar' });
        wal.append('ACTIVATE', 'job-1');
        await wal.close();
        const entries = wal.readAll();
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ op: 'ENQUEUE', jobId: 'job-1' });
        expect(entries[1]).toMatchObject({ op: 'ACTIVATE', jobId: 'job-1' });
    });

    it('readAfter returns only entries with seq > given value', async () => {
        const wal = createWal(walPath);
        wal.initialize();
        wal.append('ENQUEUE', 'a');
        wal.append('ENQUEUE', 'b');
        wal.append('ENQUEUE', 'c');
        await wal.close();
        const entries = wal.readAfter(0);
        expect(entries).toHaveLength(2); // seq 1 and seq 2
        expect(entries[0]!.jobId).toBe('b');
    });

    it('truncate clears the WAL and resets seq', async () => {
        const wal = createWal(walPath);
        wal.initialize();
        wal.append('ENQUEUE', 'a');
        await wal.truncate();
        await wal.close();
        expect(wal.readAll()).toHaveLength(0);
        expect(wal.currentSeq).toBe(0);
    });

    it('resumes seq from existing WAL on initialize', async () => {
        const wal1 = createWal(walPath);
        wal1.initialize();
        wal1.append('ENQUEUE', 'x');
        wal1.append('ENQUEUE', 'y');
        await wal1.close();

        const wal2 = createWal(walPath);
        wal2.initialize();
        expect(wal2.currentSeq).toBe(2);
    });

    it('noop when disabled', async () => {
        const wal = createWal(walPath, false);
        wal.initialize();
        wal.append('ENQUEUE', 'a');
        await wal.truncate();
        expect(wal.readAll()).toHaveLength(0);
        expect(fs.existsSync(walPath)).toBe(false);
    });

    it('returns empty array when file does not exist', () => {
        const wal = createWal(path.join(tmpDir, 'nonexistent.wal'));
        wal.initialize();
        expect(wal.readAll()).toHaveLength(0);
    });

    it('append returns the WAL entry', () => {
        const wal = createWal(walPath);
        wal.initialize();
        const entry = wal.append('CHAIN_REGISTER', 'flow-1', { steps: [] });
        expect(entry.op).toBe('CHAIN_REGISTER');
        expect(entry.jobId).toBe('flow-1');
        expect(entry.seq).toBe(0);
    });

    it('append supports all new WAL operation types', async () => {
        const wal = createWal(walPath);
        wal.initialize();
        wal.append('CHAIN_REGISTER', 'f1');
        wal.append('CHAIN_ADVANCE', 'f1');
        wal.append('CHAIN_COMPLETE', 'f1');
        wal.append('DAG_REGISTER', 'f2');
        wal.append('DAG_COMPLETE_DEP', 'f2');
        wal.append('DLQ_ADD', 'job-1');
        wal.append('DLQ_REMOVE', 'job-1');
        await wal.close();
        const entries = wal.readAll();
        expect(entries).toHaveLength(7);
        const ops = entries.map((e) => e.op);
        expect(ops).toContain('CHAIN_REGISTER');
        expect(ops).toContain('DAG_REGISTER');
        expect(ops).toContain('DLQ_ADD');
        expect(ops).toContain('DLQ_REMOVE');
    });
});
