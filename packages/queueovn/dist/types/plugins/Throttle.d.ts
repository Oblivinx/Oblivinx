import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
export interface ThrottleOptions {
    /** Maximum number of concurrent jobs across this queue */
    maxConcurrent: number;
}
/**
 * Throttle plugin — enforces a global concurrency cap per queue.
 * Throws RateLimitError on onProcess if cap is reached.
 */
export declare class Throttle implements IPlugin {
    readonly name = "Throttle";
    private activeCount;
    private readonly maxConcurrent;
    constructor({ maxConcurrent }: ThrottleOptions);
    onProcess<T extends JobPayload>(_job: Job<T>): void;
    onComplete<T extends JobPayload>(_job: Job<T>): void;
    onFail<T extends JobPayload>(_job: Job<T>, _error: Error): void;
    get current(): number;
}
