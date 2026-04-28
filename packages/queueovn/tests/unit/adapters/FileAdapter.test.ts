import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileAdapter } from '../../../src/adapters/FileAdapter.js';
import { createJob } from '../../../src/job/Job.js';

describe('FileAdapter', () => {
    let tmpDir: string;
    let filePath: string;

    beforeEach(() => {
        vi.useFakeTimers();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-file-adapter-'));
        filePath = path.join(tmpDir, 'jobs.json');
    });

    afterEach(() => {
        vi.useRealTimers();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeJob(id: string, priority = 5, delay = 0) {
        return createJob({ type: 'test', payload: { id }, priority, delay }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
    }

    it('initializes empty file if not exists', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();
        expect(fs.existsSync(filePath)).toBe(true);
        expect(await adapter.size()).toBe(0);
    });

    it('loads existing jobs from file', async () => {
        const adapter1 = new FileAdapter({ filePath });
        await adapter1.initialize();
        const j1 = makeJob('1');
        await adapter1.push(j1);

        const adapter2 = new FileAdapter({ filePath });
        await adapter2.initialize();

        const all = await adapter2.getAll();
        expect(all.length).toBe(1);
        expect(all[0]!.payload.id).toBe('1');
    });

    it('pushes and pops jobs according to priority and runAt', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();

        const j1 = makeJob('1', 5);
        const j2 = makeJob('2', 1); // higher priority
        const j3 = makeJob('3', 5, 5000); // delayed

        await adapter.push(j1);
        await adapter.push(j2);
        await adapter.push(j3);

        expect(await adapter.size()).toBe(2); // Only j1, j2 are pending and run_at <= now

        const popped1 = await adapter.pop();
        expect(popped1?.payload.id).toBe('2'); // highest priority

        const popped2 = await adapter.pop();
        expect(popped2?.payload.id).toBe('1');

        const popped3 = await adapter.pop();
        expect(popped3).toBeNull(); // j3 is delayed

        vi.advanceTimersByTime(5000);

        const popped4 = await adapter.pop();
        expect(popped4?.payload.id).toBe('3');
    });

    it('peek returns next job without removing it', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();
        await adapter.push(makeJob('1'));

        const peeked = await adapter.peek();
        expect(peeked?.payload.id).toBe('1');

        const size = await adapter.size();
        expect(size).toBe(1);
    });

    it('update modifies existing job', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();
        const j = makeJob('1');
        await adapter.push(j);

        const updated = { ...j, state: 'active' } as any;
        await adapter.update(updated);

        const got = await adapter.get(j.id);
        expect(got?.state).toBe('active');
    });

    it('remove deletes job', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();
        const j = makeJob('1');
        await adapter.push(j);
        await adapter.remove(j.id);

        expect(await adapter.get(j.id)).toBeNull();
    });

    it('clear deletes all jobs', async () => {
        const adapter = new FileAdapter({ filePath });
        await adapter.initialize();
        await adapter.push(makeJob('1'));
        await adapter.push(makeJob('2'));
        await adapter.clear();

        expect(await adapter.size()).toBe(0);
    });
});
