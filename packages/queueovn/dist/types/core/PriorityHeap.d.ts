import type { Job, JobPayload } from '../types/job.types.js';
/**
 * Min-heap priority queue (O(log n) insert & extract-min).
 * Tiebreaker: lower priority number wins → then earlier runAt → then FIFO (insertedAt).
 *
 * Stored separately from the job map to keep the heap small and fast.
 */
export declare class PriorityHeap {
    private heap;
    private readonly jobs;
    private insertCounter;
    /** Number of jobs currently in the heap */
    get size(): number;
    /** Insert a job into the heap — O(log n) */
    insert<T extends JobPayload>(job: Job<T>): void;
    /**
     * Extract (remove and return) the highest-priority job whose runAt <= now.
     * Returns null if the heap is empty or no job is ready yet.
     */
    extractMin(now: number): Job<JobPayload> | null;
    /**
     * Peek at the top entry without modification.
     */
    peekMin(now: number): Job<JobPayload> | null;
    /** Update a job already in the heap (e.g. after state change) */
    update<T extends JobPayload>(job: Job<T>): void;
    /** Remove a job by id — O(n) search then O(log n) re-heap */
    remove(id: string): void;
    /** Return all jobs (for snapshot / recovery) */
    toArray(): Job<JobPayload>[];
    /** Clear the heap */
    clear(): void;
    private compare;
    private swap;
    private bubbleUp;
    private sinkDown;
}
