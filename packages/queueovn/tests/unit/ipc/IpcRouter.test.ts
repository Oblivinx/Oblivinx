import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpcRouter } from '../../../src/ipc/IpcRouter.js';
import type { ChildProcess } from 'child_process';
import { QueueError } from '../../../src/errors/QueueError.js';
import { EventEmitter } from 'events';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockChild(connected = true): any {
    const child = new EventEmitter() as any;
    child.connected = connected;
    child.send = vi.fn((msg: any, cb?: (err: any) => void) => {
        if (cb) cb(null);
        return true;
    });
    return child;
}

/** Wait for all pending microtasks to flush (needed after async `enqueue` calls). */
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/** Auto-reply: after a tick, emit the router reply on the child. */
function autoReply(child: any, payload: string, delayMs = 5) {
    setTimeout(() => {
        const call = child.send.mock.calls.find((c: any[]) => c[0]?.reqId);
        if (call) child.emit('message', { reqId: call[0].reqId, payload });
    }, delayMs);
}

function autoReplyError(child: any, error: string, delayMs = 5) {
    setTimeout(() => {
        const call = child.send.mock.calls.find((c: any[]) => c[0]?.reqId);
        if (call) child.emit('message', { reqId: call[0].reqId, error });
    }, delayMs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IpcRouter', () => {
    let router: IpcRouter;
    let mockChild: any;

    beforeEach(() => {
        router = new IpcRouter({ requestTimeoutMs: 200 });
        mockChild = makeMockChild();
    });

    // ── Basic routing ──────────────────────────────────────────────────────

    it('registers a shard and routes enqueue to the correct child', async () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        autoReply(mockChild, 'job-123');

        const jobId = await router.enqueue({ shardKey: 'bot1', type: 'test', payload: { data: 1 } });

        expect(jobId).toBe('job-123');
        expect(mockChild.send).toHaveBeenCalledWith(
            expect.objectContaining({ cmd: 'enqueue', payload: expect.objectContaining({ shardKey: 'bot1', type: 'test' }) }),
            expect.any(Function)
        );
    });

    it('throws when shardKey is missing', async () => {
        await expect(router.enqueue({ type: 'test', payload: {} } as any))
            .rejects.toThrow('enqueue() via IpcRouter requires a shardKey');
    });

    it('throws when shard is not registered', async () => {
        await expect(router.enqueue({ shardKey: 'unknown', type: 'test', payload: {} }))
            .rejects.toThrow('No shard registered for key: unknown');
    });

    it('handles an IPC error response from the child', async () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        autoReplyError(mockChild, 'Database locked');

        await expect(router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} }))
            .rejects.toThrow('Database locked');
    });

    // ── pause / resume ─────────────────────────────────────────────────────

    it('sends pause and resume to all connected shards', () => {
        router.registerShard('bot1', mockChild as ChildProcess);

        router.pause();
        expect(mockChild.send).toHaveBeenCalledWith({ cmd: 'pause' });

        router.resume();
        expect(mockChild.send).toHaveBeenCalledWith({ cmd: 'resume' });
    });

    it('skips pause/resume for disconnected shards', () => {
        const disconnected = makeMockChild(false);
        router.registerShard('dead', disconnected as ChildProcess);

        router.pause();
        router.resume();

        expect(disconnected.send).not.toHaveBeenCalled();
    });

    // ── shutdown ───────────────────────────────────────────────────────────

    it('sends shutdown command to all connected shards', async () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        autoReply(mockChild, 'shutdown');

        await router.shutdown();

        expect(mockChild.send).toHaveBeenCalledWith(
            expect.objectContaining({ cmd: 'shutdown' }),
            expect.any(Function)
        );
    });

    it('skips shutdown for already disconnected shards', async () => {
        const disconnected = makeMockChild(false);
        router.registerShard('dead', disconnected as ChildProcess);

        await expect(router.shutdown()).resolves.toBeUndefined();
        expect(disconnected.send).not.toHaveBeenCalled();
    });

    // ── deregisterShard ────────────────────────────────────────────────────

    it('deregisterShard rejects in-flight requests for that shard', async () => {
        // Never-reply child
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(null); });
        router.registerShard('bot1', mockChild as ChildProcess);

        const promise = router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} });
        promise.catch(() => { }); // prevent unhandled rejection warning

        // Flush microtasks so enqueue's internal `await _acquireSlot` resolves
        // and the pending request is registered in the map before we deregister
        await flushMicrotasks();

        router.deregisterShard('bot1');

        await expect(promise).rejects.toThrow("IPC Channel closed for shard 'bot1'");
    });

    it('deregisterShard removes the shard from routing', async () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        router.deregisterShard('bot1');

        await expect(router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} }))
            .rejects.toThrow('No shard registered for key: bot1');
    });

    // ── disconnect / exit cleanup ──────────────────────────────────────────

    it('rejects pending requests immediately on child disconnect', async () => {
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(null); });
        router.registerShard('bot1', mockChild as ChildProcess);

        const promise = router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} });
        promise.catch(() => { }); // prevent unhandled rejection warning

        // Flush so the pending request is registered before disconnect fires
        await flushMicrotasks();

        mockChild.connected = false;
        mockChild.emit('disconnect');

        await expect(promise).rejects.toThrow("IPC Channel closed for shard 'bot1'");
    });

    it('rejects pending requests immediately on child exit', async () => {
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(null); });
        router.registerShard('bot1', mockChild as ChildProcess);

        const promise = router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} });
        promise.catch(() => { }); // prevent unhandled rejection warning

        await flushMicrotasks();

        mockChild.connected = false;
        mockChild.emit('exit');

        await expect(promise).rejects.toThrow("IPC Channel closed for shard 'bot1'");
    });

    it('rejects enqueue immediately if child is already disconnected at send time', async () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        mockChild.connected = false;

        await expect(router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} }))
            .rejects.toThrow("IPC Channel closed for shard 'bot1'");
    });

    // ── backpressure / concurrency limit ───────────────────────────────────

    it('queues requests beyond maxConcurrentPerShard and processes them in order', async () => {
        const maxConcurrent = 2;
        router = new IpcRouter({ maxConcurrentPerShard: maxConcurrent, requestTimeoutMs: 500 });

        const pending: Array<{ reqId: string }> = [];
        mockChild.send = vi.fn((msg: any, cb?: Function) => {
            if (msg.reqId) pending.push(msg);
            if (cb) cb(null);
        });

        router.registerShard('bot1', mockChild as ChildProcess);

        // Fire 4 concurrent requests — only 2 should be in-flight at once
        const results: Promise<string>[] = [];
        for (let i = 0; i < 4; i++) {
            results.push(router.enqueue({ shardKey: 'bot1', type: 'test', payload: { i } }));
        }

        // Wait for first batch to be in-flight
        await vi.waitFor(() => expect(pending.length).toBe(maxConcurrent));

        // Reply to first batch → unblocks second batch
        const [first, second] = pending.splice(0, 2);
        mockChild.emit('message', { reqId: first.reqId, payload: `job-${first.reqId}` });
        mockChild.emit('message', { reqId: second.reqId, payload: `job-${second.reqId}` });

        // Wait for second batch to be in-flight
        await vi.waitFor(() => expect(pending.length).toBe(2));

        const [third, fourth] = pending.splice(0, 2);
        mockChild.emit('message', { reqId: third.reqId, payload: `job-${third.reqId}` });
        mockChild.emit('message', { reqId: fourth.reqId, payload: `job-${fourth.reqId}` });

        const resolved = await Promise.all(results);
        expect(resolved).toHaveLength(4);
        resolved.forEach((id) => expect(id).toMatch(/^job-/));
    });

    it('drains wait-queue and rejects waiters on child disconnect', async () => {
        router = new IpcRouter({ maxConcurrentPerShard: 1, requestTimeoutMs: 500 });

        // Never-reply child
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(null); });
        router.registerShard('bot1', mockChild as ChildProcess);

        // First request occupies the single slot.
        // Pre-attach .catch immediately so the rejection is never "unhandled"
        // regardless of when the disconnect fires relative to our await.
        const firstErrors: Error[] = [];
        const secondErrors: Error[] = [];

        const first = router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} });
        first.catch((e) => firstErrors.push(e));

        await flushMicrotasks(); // let first get registered in pendingRequests

        // Second request must wait in waitQueue (slot is full)
        const second = router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} });
        second.catch((e) => secondErrors.push(e));

        await flushMicrotasks(); // let second enter waitQueue

        // Kill the child — both should reject
        mockChild.connected = false;
        mockChild.emit('disconnect');
        await flushMicrotasks(); // let rejections propagate

        await expect(first).rejects.toThrow("IPC Channel closed for shard 'bot1'");
        await expect(second).rejects.toThrow("IPC Channel closed for shard 'bot1'");
    });

    // ── request timeout ────────────────────────────────────────────────────

    it('rejects with timeout error if child never replies', async () => {
        router = new IpcRouter({ requestTimeoutMs: 50 });
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(null); });
        router.registerShard('bot1', mockChild as ChildProcess);

        await expect(
            router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} })
        ).rejects.toThrow("IPC Request timeout for cmd 'enqueue' on shard 'bot1'");
    }, 1000);

    // ── send error callback ────────────────────────────────────────────────

    it('rejects immediately if child.send returns an error', async () => {
        const sendError = new Error('EPIPE: broken pipe');
        mockChild.send = vi.fn((msg: any, cb?: Function) => { if (cb) cb(sendError); });
        router.registerShard('bot1', mockChild as ChildProcess);

        await expect(router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} }))
            .rejects.toThrow('EPIPE: broken pipe');
    });

    // ── multiple shards ────────────────────────────────────────────────────

    it('routes requests to the correct shard among multiple registered shards', async () => {
        const child2 = makeMockChild();
        router.registerShard('bot1', mockChild as ChildProcess);
        router.registerShard('bot2', child2 as ChildProcess);

        autoReply(mockChild, 'job-from-bot1');
        autoReply(child2, 'job-from-bot2');

        const [id1, id2] = await Promise.all([
            router.enqueue({ shardKey: 'bot1', type: 'test', payload: {} }),
            router.enqueue({ shardKey: 'bot2', type: 'test', payload: {} }),
        ]);

        expect(id1).toBe('job-from-bot1');
        expect(id2).toBe('job-from-bot2');
    });

    it('ignores messages that have no matching reqId', () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        expect(() => {
            mockChild.emit('message', { reqId: 'nonexistent', payload: 'x' });
        }).not.toThrow();
    });

    it('ignores messages that carry no reqId at all', () => {
        router.registerShard('bot1', mockChild as ChildProcess);
        expect(() => {
            mockChild.emit('message', { cmd: 'heartbeat' });
        }).not.toThrow();
    });
});