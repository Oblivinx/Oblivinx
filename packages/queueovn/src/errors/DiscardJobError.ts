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
export class DiscardJobError extends Error {
    readonly isDiscardJobError = true;

    constructor(message: string) {
        super(message);
        this.name = 'DiscardJobError';
        Object.setPrototypeOf(this, new.target.prototype);
    }

    static is(err: unknown): err is DiscardJobError {
        return (
            err instanceof DiscardJobError ||
            (err instanceof Error && (err as DiscardJobError).isDiscardJobError === true)
        );
    }
}
