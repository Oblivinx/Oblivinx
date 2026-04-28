"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scheduler = void 0;
const sleep_js_1 = require("../utils/sleep.cjs");
const clock_js_1 = require("../utils/clock.cjs");
/**
 * Scheduler — manages delayed and future job dispatch.
 * Uses clock-based timers so they can be controlled in tests with vi.useFakeTimers().
 */
class Scheduler {
    entries = new Map();
    callbacks = [];
    clock;
    constructor(clock = clock_js_1.systemClock) {
        this.clock = clock;
    }
    /**
     * Register a callback called when a scheduled job is due.
     */
    onReady(cb) {
        this.callbacks.push(cb);
    }
    /**
     * Schedule a job to fire at a specific timestamp (ms since epoch).
     */
    schedule(job, runAt) {
        const delay = Math.max(0, runAt - this.clock.now());
        const timerId = setTimeout(() => {
            this.entries.delete(job.id);
            for (const cb of this.callbacks)
                cb(job);
        }, delay);
        this.entries.set(job.id, { job: job, runAt, timerId });
    }
    /**
     * Cancel a scheduled job.
     */
    cancel(jobId) {
        const entry = this.entries.get(jobId);
        if (entry) {
            clearTimeout(entry.timerId);
            this.entries.delete(jobId);
        }
    }
    /**
     * Number of currently scheduled (pending-delayed) jobs.
     */
    get size() {
        return this.entries.size;
    }
    /**
     * Returns all scheduled jobs (for persistence/recovery).
     */
    scheduledJobs() {
        return Array.from(this.entries.values()).map((e) => e.job);
    }
    /**
     * Cancel all scheduled jobs.
     */
    clear() {
        for (const entry of this.entries.values()) {
            clearTimeout(entry.timerId);
        }
        this.entries.clear();
    }
}
exports.Scheduler = Scheduler;
// Keep sleep in scope so tree-shaking doesn't pull it out across boundaries
void sleep_js_1.sleep;
