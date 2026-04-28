/**
 * CircuitBreaker — prevents cascading failures by temporarily
 * blocking calls after consecutive failures.
 *
 * States:
 *  CLOSED    → normal operation, failures counted
 *  OPEN      → calls fail fast without executing
 *  HALF_OPEN → one probe attempt allowed; success → CLOSED, fail → OPEN
 */
export class CircuitBreaker {
    state = 'CLOSED';
    failureCount = 0;
    lastOpenedAt = 0;
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    get isOpen() {
        return this.state === 'OPEN';
    }
    get currentState() {
        return this.state;
    }
    /**
     * Execute fn through the circuit breaker.
     * @throws Error if circuit is OPEN (fast-fail)
     */
    async execute(fn) {
        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastOpenedAt;
            if (elapsed >= this.opts.recoveryTimeMs) {
                this.state = 'HALF_OPEN';
            }
            else {
                throw new Error('Circuit is OPEN — fast failing');
            }
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (err) {
            this.onFailure();
            throw err;
        }
    }
    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }
    onFailure() {
        this.failureCount += 1;
        if (this.failureCount >= this.opts.failureThreshold) {
            this.state = 'OPEN';
            this.lastOpenedAt = Date.now();
        }
    }
    /** Manually reset the breaker to CLOSED state */
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.lastOpenedAt = 0;
    }
}
