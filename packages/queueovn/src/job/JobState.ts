/**
 * JobState FSM enum — all possible states a job can inhabit.
 *
 * Transitions:
 *   pending  → active    (worker picks up job)
 *   active   → done      (handler resolves)
 *   active   → failed    (handler throws, no retry)
 *   active   → retrying  (handler throws, retry scheduled)
 *   retrying → pending   (backoff delay expires)
 *   pending  → paused    (queue.pause())
 *   paused   → pending   (queue.resume())
 *   pending  → expired   (TTL exceeded before processing)
 *   failed   → dlq       (permanent failure captured by DLQ plugin)
 */
export enum JobState {
    PENDING = 'pending',
    ACTIVE = 'active',
    DONE = 'done',
    FAILED = 'failed',
    RETRYING = 'retrying',
    PAUSED = 'paused',
    EXPIRED = 'expired',
    DLQ = 'dlq',
}
