/**
 * Base error class for all wa-job-queue errors.
 * All custom errors extend this class.
 */
export class QueueError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'QueueError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
