import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Snapshot } from '../../../src/persistence/Snapshot.js';
import { MemoryAdapter } from '../../../src/adapters/MemoryAdapter.js';
import { createJob } from '../../../src/job/Job.js';

const defaults = { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 };

describe('Snapshot', () => {
    let tmpDir: string;
    let snapshotPath: string;
    let adapter: MemoryAdapter;

    beforeEach(() => {
        vi.useRealTimers();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-snapshot-test-'));
        snapshotPath = path.join(tmpDir, 'snapshot.json');
        adapter = new MemoryAdapter();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeJob() {
        return createJob({ type: 'test', payload: {} }, defaults);
    }

    it('write persists jobs atomically (async) and updates lastSnapshotSeq', async () => {
        await adapter.push(makeJob());
        const snap = new Snapshot(snapshotPath, adapter);
        await snap.write(5);
        expect(fs.existsSync(snapshotPath)).toBe(true);
        const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        expect(raw.seq).toBe(5);
        expect(raw.jobs).toHaveLength(1);
        expect(snap.lastSnapshotSeq).toBe(5);
    });

    it('write creates parent directories if they do not exist', async () => {
        const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'snap.json');
        const snap = new Snapshot(deepPath, adapter);
        await snap.write(0);
        expect(fs.existsSync(deepPath)).toBe(true);
    });

    it('read returns null when snapshot file does not exist', () => {
        const snap = new Snapshot(path.join(tmpDir, 'nofile.json'), adapter);
        expect(snap.read()).toBeNull();
    });

    it('read returns null when snapshot file is corrupted JSON', () => {
        fs.writeFileSync(snapshotPath, '{ invalid json', 'utf8');
        const snap = new Snapshot(snapshotPath, adapter);
        expect(snap.read()).toBeNull();
    });

    it('read returns SnapshotData with jobs on valid file', async () => {
        const snap = new Snapshot(snapshotPath, adapter);
        await adapter.push(makeJob());
        await snap.write(3);
        const data = snap.read();
        expect(data).not.toBeNull();
        expect(data!.seq).toBe(3);
        expect(data!.jobs).toHaveLength(1);
    });

    it('lastSnapshotSeq defaults to -1 before any write', () => {
        const snap = new Snapshot(snapshotPath, adapter);
        expect(snap.lastSnapshotSeq).toBe(-1);
    });

    it('schedule calls write at the interval and calls onSuccess', async () => {
        vi.useFakeTimers();
        const snap = new Snapshot(snapshotPath, adapter);
        // Spy on write so we avoid real async fs in fake timer environment
        const writeSpy = vi.spyOn(snap, 'write').mockResolvedValue(undefined);
        const onSuccess = vi.fn();
        snap.schedule(1000, () => 7, onSuccess);
        await vi.advanceTimersByTimeAsync(1001);
        expect(writeSpy).toHaveBeenCalledWith(7);
        expect(onSuccess).toHaveBeenCalled();
        snap.stop();
        vi.useRealTimers();
    });

    it('schedule calls onError callback when write fails', async () => {
        vi.useFakeTimers();
        const snap = new Snapshot(snapshotPath, adapter);
        vi.spyOn(adapter, 'getAll').mockRejectedValue(new Error('disk full'));
        const onError = vi.fn();
        snap.schedule(500, () => 0, undefined, onError);
        await vi.advanceTimersByTimeAsync(600);
        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        snap.stop();
        vi.useRealTimers();
    });

    it('schedule is a no-op if called twice — only one interval runs', async () => {
        vi.useFakeTimers();
        const snap = new Snapshot(snapshotPath, adapter);
        const writeSpy = vi.spyOn(snap, 'write').mockResolvedValue(undefined);
        const onSuccess = vi.fn();
        snap.schedule(1000, () => 0, onSuccess);
        snap.schedule(1000, () => 0, onSuccess); // second call is no-op
        await vi.advanceTimersByTimeAsync(1001);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        snap.stop();
        vi.useRealTimers();
    });

    it('stop clears the interval — no further callbacks after stop', async () => {
        vi.useFakeTimers();
        const snap = new Snapshot(snapshotPath, adapter);
        const onSuccess = vi.fn();
        snap.schedule(500, () => 0, onSuccess);
        snap.stop();
        await vi.advanceTimersByTimeAsync(2000);
        expect(onSuccess).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('stop is a no-op if schedule was never called', () => {
        const snap = new Snapshot(snapshotPath, adapter);
        expect(() => snap.stop()).not.toThrow();
    });
});
