/**
 * NoRetry — fail-fast policy.
 * Always returns false from shouldRetry(), so jobs fail immediately.
 */
export class NoRetry {
    static _instance;
    constructor() { }
    /** Get the singleton NoRetry instance */
    static getInstance() {
        if (!NoRetry._instance) {
            NoRetry._instance = new NoRetry();
        }
        return NoRetry._instance;
    }
    shouldRetry(_attempt, _error) {
        return false;
    }
    nextDelay(_attempt, _error) {
        return 0;
    }
}
