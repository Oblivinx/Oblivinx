import { RateLimitError } from '../errors/RateLimitError.js';
/**
 * Throttle plugin — enforces a global concurrency cap per queue.
 * Throws RateLimitError on onProcess if cap is reached.
 */
export class Throttle {
    name = 'Throttle';
    activeCount = 0;
    maxConcurrent;
    constructor({ maxConcurrent }) {
        this.maxConcurrent = maxConcurrent;
    }
    onProcess(_job) {
        if (this.activeCount >= this.maxConcurrent) {
            throw new RateLimitError(`Concurrency limit of ${this.maxConcurrent} reached`);
        }
        this.activeCount += 1;
    }
    onComplete(_job) {
        this.activeCount = Math.max(0, this.activeCount - 1);
    }
    onFail(_job, _error) {
        this.activeCount = Math.max(0, this.activeCount - 1);
    }
    get current() {
        return this.activeCount;
    }
}
