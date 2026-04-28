/**
 * CircuitBreaker states
 */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
    /** Number of consecutive failures before opening the circuit */
    failureThreshold: number;
    /** Time in ms to wait before attempting a half-open probe */
    recoveryTimeMs: number;
}

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
    private state: CircuitState = 'CLOSED';
    private failureCount = 0;
    private lastOpenedAt = 0;
    private readonly opts: CircuitBreakerOptions;

    constructor(opts: CircuitBreakerOptions) {
        this.opts = opts;
    }

    get isOpen(): boolean {
        return this.state === 'OPEN';
    }

    get currentState(): CircuitState {
        return this.state;
    }

    /**
     * Execute fn through the circuit breaker.
     * @throws Error if circuit is OPEN (fast-fail)
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastOpenedAt;
            if (elapsed >= this.opts.recoveryTimeMs) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error('Circuit is OPEN — fast failing');
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (err) {
            this.onFailure();
            throw err;
        }
    }

    private onSuccess(): void {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    private onFailure(): void {
        this.failureCount += 1;
        if (this.failureCount >= this.opts.failureThreshold) {
            this.state = 'OPEN';
            this.lastOpenedAt = Date.now();
        }
    }

    /** Manually reset the breaker to CLOSED state */
    reset(): void {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.lastOpenedAt = 0;
    }
}
