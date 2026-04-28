import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import { RateLimitError } from '../errors/RateLimitError.js';

export interface ThrottleOptions {
    /** Maximum number of concurrent jobs across this queue */
    maxConcurrent: number;
}

/**
 * Throttle plugin — enforces a global concurrency cap per queue.
 * Throws RateLimitError on onProcess if cap is reached.
 */
export class Throttle implements IPlugin {
    readonly name = 'Throttle';
    private activeCount = 0;
    private readonly maxConcurrent: number;

    constructor({ maxConcurrent }: ThrottleOptions) {
        this.maxConcurrent = maxConcurrent;
    }

    onProcess<T extends JobPayload>(_job: Job<T>): void {
        if (this.activeCount >= this.maxConcurrent) {
            throw new RateLimitError(
                `Concurrency limit of ${this.maxConcurrent} reached`,
            );
        }
        this.activeCount += 1;
    }

    onComplete<T extends JobPayload>(_job: Job<T>): void {
        this.activeCount = Math.max(0, this.activeCount - 1);
    }

    onFail<T extends JobPayload>(_job: Job<T>, _error: Error): void {
        this.activeCount = Math.max(0, this.activeCount - 1);
    }

    get current(): number {
        return this.activeCount;
    }
}
