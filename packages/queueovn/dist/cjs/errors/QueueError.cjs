"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueError = void 0;
/**
 * Base error class for all wa-job-queue errors.
 * All custom errors extend this class.
 */
class QueueError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'QueueError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.QueueError = QueueError;
