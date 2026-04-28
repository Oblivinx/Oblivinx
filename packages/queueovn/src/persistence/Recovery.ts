import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import { updateJob } from '../job/Job.js';
import { JobState } from '../job/JobState.js';
import { WALWriter } from './WALWriter.js';
import { Snapshot } from './Snapshot.js';

/**
 * Recovery — crash recovery orchestrator.
 * On startup: load snapshot → replay WAL → reset in-flight → rebuild heap.
 */
export class Recovery {
    private readonly walWriter: WALWriter;
    private readonly snapshot: Snapshot;
    private readonly adapter: IStorageAdapter;

    constructor(walWriter: WALWriter, snapshot: Snapshot, adapter: IStorageAdapter) {
        this.walWriter = walWriter;
        this.snapshot = snapshot;
        this.adapter = adapter;
    }

    /**
     * Run the full recovery procedure.
     * Call this before starting workers.
     */
    async run(): Promise<void> {
        // Step 1: Try to load snapshot
        const snap = this.snapshot.read();
        let baseSeq = -1;

        if (snap) {
            // Restore snapshot jobs into adapter
            for (const job of snap.jobs) {
                await this.adapter.push(job as Job<JobPayload>);
            }
            baseSeq = snap.seq;
        }

        // Step 2: Replay WAL entries after snapshot's seq
        const walEntries = this.walWriter.readAfter(baseSeq);
        for (const entry of walEntries) {
            await this.replayEntry(entry.op, entry.jobId, entry.data);
        }

        // Step 3: Reset ACTIVE jobs → PENDING (they were in-flight at crash)
        const allJobs = await this.adapter.getAll<JobPayload>();
        for (const job of allJobs) {
            if (job.state === JobState.ACTIVE) {
                const reset = updateJob(job, {
                    state: JobState.PENDING,
                    startedAt: undefined,
                });
                await this.adapter.update(reset);
            }
        }
    }

    private async replayEntry(
        op: string,
        jobId: string,
        data: unknown,
    ): Promise<void> {
        switch (op) {
            case 'ENQUEUE': {
                if (data && typeof data === 'object') {
                    await this.adapter.push(data as Job<JobPayload>);
                }
                break;
            }
            case 'ACTIVATE': {
                const job = await this.adapter.get<JobPayload>(jobId);
                if (job) {
                    await this.adapter.update(updateJob(job, { state: JobState.ACTIVE }));
                }
                break;
            }
            case 'COMPLETE':
            case 'FAIL':
            case 'DLQ':
            case 'EXPIRE': {
                await this.adapter.remove(jobId);
                break;
            }
            case 'RETRY': {
                const job = await this.adapter.get<JobPayload>(jobId);
                if (job) {
                    await this.adapter.update(updateJob(job, { state: JobState.RETRYING }));
                }
                break;
            }
            default:
                break;
        }
    }
}
