import type { JobOptions, JobPayload } from '../types/job.types.js';
export interface IpcMessage {
    cmd: string;
    payload?: any;
    error?: string;
    reqId?: string;
}
export interface ShardedQueue {
    enqueue<T extends JobPayload>(options: JobOptions<T>): Promise<string>;
    pause(): void;
    resume(): void;
    shutdown(): Promise<void>;
}
