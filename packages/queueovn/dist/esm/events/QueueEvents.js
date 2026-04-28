/** String constant names for all queue events */
export const QueueEvent = {
    ENQUEUED: 'enqueued',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed',
    RETRYING: 'retrying',
    EXPIRED: 'expired',
    DEAD_LETTER: 'dead-letter',
    FLOW_COMPLETED: 'flow:completed',
    FLOW_FAILED: 'flow:failed',
    WORKER_SCALED_UP: 'worker:scaled-up',
    WORKER_SCALED_DOWN: 'worker:scaled-down',
    WORKER_ERROR: 'worker:error',
    ERROR: 'error',
};
// Suppress unused import lint warning — JobPayload is used in QueueEventMap
const _unused = undefined;
void _unused;
