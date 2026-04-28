import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OvnDbAdapter } from '../../../src/adapters/OvnDbAdapter.js';
import { createJob } from '../../../src/job/Job.js';

describe('OvnDbAdapter', () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        vi.useFakeTimers();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ovndb-adapter-'));
        dbPath = path.join(tmpDir, 'jobs.ovn');
    });

    afterEach(() => {
        vi.useRealTimers();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeJob(id: string, priority = 5, delay = 0) {
        return createJob({ type: 'test', payload: { id }, priority, delay }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
    }

    it('initializes tables and WAL mode', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        expect(fs.existsSync(dbPath)).toBe(true);
        expect(await adapter.size()).toBe(0);
        await adapter.close();
    });

    it('pushes and pops jobs according to priority and runAt', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();

        const j1 = makeJob('1', 5);
        const j2 = makeJob('2', 1); // higher priority
        const j3 = makeJob('3', 5, 5000); // delayed

        await adapter.push(j1);
        await adapter.push(j2);
        await adapter.push(j3);

        expect(await adapter.size()).toBe(2);

        const popped1 = await adapter.pop();
        expect(popped1?.payload.id).toBe('2');

        const popped2 = await adapter.pop();
        expect(popped2?.payload.id).toBe('1');

        const popped3 = await adapter.pop();
        expect(popped3).toBeNull();

        vi.advanceTimersByTime(5000);

        const popped4 = await adapter.pop();
        expect(popped4?.payload.id).toBe('3');

        await adapter.close();
    });

    it('peek returns next job without marking it active', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        await adapter.push(makeJob('1'));

        const peeked = await adapter.peek();
        expect(peeked?.payload.id).toBe('1');

        const size = await adapter.size();
        expect(size).toBe(1);

        await adapter.close();
    });

    it('pop marks the state as active in db', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        const j = makeJob('1');
        await adapter.push(j);

        const popped = await adapter.pop();
        expect(popped).toBeDefined();

        // Internally it should be 'active' now, so size is 0 and peek is null
        expect(await adapter.size()).toBe(0);
        expect(await adapter.peek()).toBeNull();

        await adapter.close();
    });

    it('update modifies existing job', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        const j = makeJob('1');
        await adapter.push(j);

        const updated = { ...j, state: 'paused' } as any;
        await adapter.update(updated);

        const got = await adapter.get(j.id);
        expect(got?.state).toBe('paused');
        await adapter.close();
    });

    it('remove deletes job', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        const j = makeJob('1');
        await adapter.push(j);
        await adapter.remove(j.id);

        expect(await adapter.get(j.id)).toBeNull();
        await adapter.close();
    });

    it('clear deletes all jobs', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await adapter.initialize();
        await adapter.push(makeJob('1'));
        await adapter.push(makeJob('2'));
        await adapter.clear();

        expect(await adapter.size()).toBe(0);
        const all = await adapter.getAll();
        expect(all.length).toBe(0);
        await adapter.close();
    });

    it('throws if not initialized', async () => {
        const adapter = new OvnDbAdapter({ path: dbPath });
        await expect(adapter.size()).rejects.toThrow('OvnDbAdapter not initialized');
    });
});
