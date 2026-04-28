"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Recovery = void 0;
const Job_js_1 = require("../job/Job.cjs");
const JobState_js_1 = require("../job/JobState.cjs");
/**
 * Recovery — crash recovery orchestrator.
 * On startup: load snapshot → replay WAL → reset in-flight → rebuild heap.
 */
class Recovery {
    walWriter;
    snapshot;
    adapter;
    constructor(walWriter, snapshot, adapter) {
        this.walWriter = walWriter;
        this.snapshot = snapshot;
        this.adapter = adapter;
    }
    /**
     * Run the full recovery procedure.
     * Call this before starting workers.
     */
    async run() {
        // Step 1: Try to load snapshot
        const snap = this.snapshot.read();
        let baseSeq = -1;
        if (snap) {
            // Restore snapshot jobs into adapter
            for (const job of snap.jobs) {
                await this.adapter.push(job);
            }
            baseSeq = snap.seq;
        }
        // Step 2: Replay WAL entries after snapshot's seq
        const walEntries = this.walWriter.readAfter(baseSeq);
        for (const entry of walEntries) {
            await this.replayEntry(entry.op, entry.jobId, entry.data);
        }
        // Step 3: Reset ACTIVE jobs → PENDING (they were in-flight at crash)
        const allJobs = await this.adapter.getAll();
        for (const job of allJobs) {
            if (job.state === JobState_js_1.JobState.ACTIVE) {
                const reset = (0, Job_js_1.updateJob)(job, {
                    state: JobState_js_1.JobState.PENDING,
                    startedAt: undefined,
                });
                await this.adapter.update(reset);
            }
        }
    }
    async replayEntry(op, jobId, data) {
        switch (op) {
            case 'ENQUEUE': {
                if (data && typeof data === 'object') {
                    await this.adapter.push(data);
                }
                break;
            }
            case 'ACTIVATE': {
                const job = await this.adapter.get(jobId);
                if (job) {
                    await this.adapter.update((0, Job_js_1.updateJob)(job, { state: JobState_js_1.JobState.ACTIVE }));
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
                const job = await this.adapter.get(jobId);
                if (job) {
                    await this.adapter.update((0, Job_js_1.updateJob)(job, { state: JobState_js_1.JobState.RETRYING }));
                }
                break;
            }
            default:
                break;
        }
    }
}
exports.Recovery = Recovery;
