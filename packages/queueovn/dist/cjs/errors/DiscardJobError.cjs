"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscardJobError = void 0;
/**
 * DiscardJobError — thrown by plugins to silently discard a job without re-queuing it.
 *
 * Unlike RateLimitError (which causes the job to be put back), this signals
 * the queue to permanently drop the job without further processing.
 *
 * @example
 * // Inside a plugin's onProcess:
 * throw new DiscardJobError('Job superseded by a newer debounced job');
 */
class DiscardJobError extends Error {
    isDiscardJobError = true;
    constructor(message) {
        super(message);
        this.name = 'DiscardJobError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
    static is(err) {
        return (err instanceof DiscardJobError ||
            (err instanceof Error && err.isDiscardJobError === true));
    }
}
exports.DiscardJobError = DiscardJobError;
