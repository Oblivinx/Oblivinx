import type { JobQueue } from '../core/JobQueue.js';
import type { IpcMessage } from './types.js';

export class IpcWorker {
    private readonly queue: JobQueue;

    constructor(queue: JobQueue) {
        this.queue = queue;
    }

    /**
     * Start listening to IPC messages from the IpcRouter (main process).
     * Only processes messages that carry a `reqId` (i.e. router-originated).
     * Other messages (e.g. heartbeats, custom signals) are ignored.
     */
    start(): void {
        process.on('message', (msg: IpcMessage) => {
            // Ignore messages that are not IPC router commands
            if (!msg.reqId) return;

            this.handleMessage(msg).catch((err) => {
                if (msg.reqId && process.send) {
                    process.send({ reqId: msg.reqId, error: err.message });
                }
            });
        });
    }

    private async handleMessage(msg: IpcMessage): Promise<void> {
        if (!process.send) return;

        try {
            switch (msg.cmd) {
                case 'enqueue': {
                    const jobId = await this.queue.enqueue(msg.payload);
                    process.send({ reqId: msg.reqId, payload: jobId });
                    break;
                }
                case 'pause': {
                    this.queue.pause();
                    process.send({ reqId: msg.reqId, payload: 'paused' });
                    break;
                }
                case 'resume': {
                    this.queue.resume();
                    process.send({ reqId: msg.reqId, payload: 'resumed' });
                    break;
                }
                case 'shutdown': {
                    await this.queue.shutdown();
                    process.send({ reqId: msg.reqId, payload: 'shutdown' });
                    break;
                }
                default:
                    throw new Error(`Unknown IPC command: ${msg.cmd}`);
            }
        } catch (err: any) {
            process.send({ reqId: msg.reqId, error: err.message });
        }
    }
}
