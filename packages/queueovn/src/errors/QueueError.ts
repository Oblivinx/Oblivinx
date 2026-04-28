/**
 * Base error class for all wa-job-queue errors.
 * All custom errors extend this class.
 */
export class QueueError extends Error {
    constructor(message: string, public override readonly cause?: unknown) {
        super(message);
        this.name = 'QueueError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
