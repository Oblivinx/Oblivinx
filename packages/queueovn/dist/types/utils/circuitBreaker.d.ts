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
export declare class CircuitBreaker {
    private state;
    private failureCount;
    private lastOpenedAt;
    private readonly opts;
    constructor(opts: CircuitBreakerOptions);
    get isOpen(): boolean;
    get currentState(): CircuitState;
    /**
     * Execute fn through the circuit breaker.
     * @throws Error if circuit is OPEN (fast-fail)
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    /** Manually reset the breaker to CLOSED state */
    reset(): void;
}
export {};
