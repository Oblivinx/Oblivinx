export class IpcWorker {
    queue;
    constructor(queue) {
        this.queue = queue;
    }
    /**
     * Start listening to IPC messages from the IpcRouter (main process).
     * Only processes messages that carry a `reqId` (i.e. router-originated).
     * Other messages (e.g. heartbeats, custom signals) are ignored.
     */
    start() {
        process.on('message', (msg) => {
            // Ignore messages that are not IPC router commands
            if (!msg.reqId)
                return;
            this.handleMessage(msg).catch((err) => {
                if (msg.reqId && process.send) {
                    process.send({ reqId: msg.reqId, error: err.message });
                }
            });
        });
    }
    async handleMessage(msg) {
        if (!process.send)
            return;
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
        }
        catch (err) {
            process.send({ reqId: msg.reqId, error: err.message });
        }
    }
}
