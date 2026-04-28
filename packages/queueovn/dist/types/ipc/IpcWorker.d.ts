import type { JobQueue } from '../core/JobQueue.js';
export declare class IpcWorker {
    private readonly queue;
    constructor(queue: JobQueue);
    /**
     * Start listening to IPC messages from the IpcRouter (main process).
     * Only processes messages that carry a `reqId` (i.e. router-originated).
     * Other messages (e.g. heartbeats, custom signals) are ignored.
     */
    start(): void;
    private handleMessage;
}
