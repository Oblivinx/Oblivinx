import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpcWorker } from '../../../src/ipc/IpcWorker.js';
import { JobQueue } from '../../../src/core/JobQueue.js';

describe('IpcWorker', () => {
    let worker: IpcWorker;
    let mockQueue: any;
    let originalProcessOn: typeof process.on;
    let originalProcessSend: typeof process.send;
    let messageHandler: (msg: any) => void;

    beforeEach(() => {
        mockQueue = {
            enqueue: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            shutdown: vi.fn().mockResolvedValue(undefined),
        } as unknown as JobQueue;

        worker = new IpcWorker(mockQueue);

        originalProcessOn = process.on;
        originalProcessSend = process.send;

        process.on = vi.fn((event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
            return process;
        }) as any;

        process.send = vi.fn() as any;
    });

    afterEach(() => {
        process.on = originalProcessOn;
        process.send = originalProcessSend;
    });

    // ── start / message routing ────────────────────────────────────────────

    it('registers a process message listener on start()', () => {
        worker.start();
        expect(process.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('ignores messages that have no reqId (non-router messages)', () => {
        worker.start();
        // Returns undefined synchronously — no queue methods should be called
        messageHandler({ cmd: 'heartbeat' });
        expect(mockQueue.enqueue).not.toHaveBeenCalled();
        expect(process.send).not.toHaveBeenCalled();
    });

    // ── enqueue ────────────────────────────────────────────────────────────

    it('handles enqueue command and replies with the new jobId', async () => {
        worker.start();
        mockQueue.enqueue.mockResolvedValue('job-abc');

        await messageHandler({
            cmd: 'enqueue',
            reqId: 'req-1',
            payload: { type: 'sendMsg', payload: { text: 'hi' } },
        });

        expect(mockQueue.enqueue).toHaveBeenCalledWith({ type: 'sendMsg', payload: { text: 'hi' } });
        expect(process.send).toHaveBeenCalledWith({ reqId: 'req-1', payload: 'job-abc' });
    });

    // ── pause / resume ─────────────────────────────────────────────────────

    it('handles pause command', async () => {
        worker.start();

        await messageHandler({ cmd: 'pause', reqId: 'req-pause' });

        expect(mockQueue.pause).toHaveBeenCalled();
        expect(process.send).toHaveBeenCalledWith({ reqId: 'req-pause', payload: 'paused' });
    });

    it('handles resume command', async () => {
        worker.start();

        await messageHandler({ cmd: 'resume', reqId: 'req-resume' });

        expect(mockQueue.resume).toHaveBeenCalled();
        expect(process.send).toHaveBeenCalledWith({ reqId: 'req-resume', payload: 'resumed' });
    });

    // ── shutdown ───────────────────────────────────────────────────────────

    it('handles shutdown command and waits for queue to finish', async () => {
        worker.start();

        await messageHandler({ cmd: 'shutdown', reqId: 'req-shutdown' });

        expect(mockQueue.shutdown).toHaveBeenCalled();
        expect(process.send).toHaveBeenCalledWith({ reqId: 'req-shutdown', payload: 'shutdown' });
    });

    // ── error handling ─────────────────────────────────────────────────────

    it('sends error reply when enqueue throws', async () => {
        worker.start();
        mockQueue.enqueue.mockRejectedValue(new Error('Adapter unavailable'));

        await messageHandler({ cmd: 'enqueue', reqId: 'req-err', payload: { type: 'test', payload: {} } });

        expect(process.send).toHaveBeenCalledWith({ reqId: 'req-err', error: 'Adapter unavailable' });
    });

    it('sends error reply for unknown command', async () => {
        worker.start();

        await messageHandler({ cmd: 'unknown_cmd', reqId: 'req-unknown' });

        expect(process.send).toHaveBeenCalledWith({
            reqId: 'req-unknown',
            error: 'Unknown IPC command: unknown_cmd',
        });
    });

    it('does nothing when process.send is not available (non-worker context)', async () => {
        // process.send is undefined in non-forked processes
        (process as any).send = undefined;
        worker.start();

        // handleMessage returns early — should not throw
        const result = messageHandler({ cmd: 'enqueue', reqId: 'req-1', payload: {} });
        // messageHandler is sync (returns void) when reqId filtering passes but send is null
        // just ensure it didn't throw and no queue calls happened
        expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });
});