import type { Job, JobPayload, JobResult } from '../types/job.types.js';

/** All events emitted by the queue and their payload types */
export interface QueueEventMap {
    enqueued: [job: Job];
    active: [job: Job];
    completed: [job: Job, result: JobResult];
    failed: [job: Job, error: Error];
    retrying: [job: Job, attempt: number];
    expired: [job: Job];
    'dead-letter': [job: Job, error: Error];
    'flow:completed': [flowId: string];
    'flow:failed': [flowId: string, error: Error];
    'worker:scaled-up': [count: number];
    'worker:scaled-down': [count: number];
    'worker:error': [error: Error];
    error: [error: Error];
}

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
} as const;

export type QueueEventName = keyof QueueEventMap;

/** Helper: used by typed event wrappers */
export type QueueEventArgs<K extends QueueEventName> = QueueEventMap[K];

// Suppress unused import lint warning — JobPayload is used in QueueEventMap
const _unused: JobPayload | undefined = undefined;
void _unused;
