import type { Job, JobResult } from '../types/job.types.js';
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
export declare const QueueEvent: {
    readonly ENQUEUED: "enqueued";
    readonly ACTIVE: "active";
    readonly COMPLETED: "completed";
    readonly FAILED: "failed";
    readonly RETRYING: "retrying";
    readonly EXPIRED: "expired";
    readonly DEAD_LETTER: "dead-letter";
    readonly FLOW_COMPLETED: "flow:completed";
    readonly FLOW_FAILED: "flow:failed";
    readonly WORKER_SCALED_UP: "worker:scaled-up";
    readonly WORKER_SCALED_DOWN: "worker:scaled-down";
    readonly WORKER_ERROR: "worker:error";
    readonly ERROR: "error";
};
export type QueueEventName = keyof QueueEventMap;
/** Helper: used by typed event wrappers */
export type QueueEventArgs<K extends QueueEventName> = QueueEventMap[K];
