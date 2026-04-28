"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryAdapter = void 0;
const PriorityHeap_js_1 = require("../core/PriorityHeap.cjs");
const AdapterError_js_1 = require("../errors/AdapterError.cjs");
/**
 * MemoryAdapter — default in-process adapter, zero external dependencies.
 * Uses PriorityHeap internally for O(log n) priority scheduling.
 */
class MemoryAdapter {
    heap = new PriorityHeap_js_1.PriorityHeap();
    /** Holds jobs in non-pending states (active, done, failed, etc.) */
    store = new Map();
    // fix: secondary index for O(1) get() on heap-pending jobs instead of O(n) toArray().find()
    pendingIndex = new Map();
    async push(job) {
        this.heap.insert(job);
        // fix: keep index in sync on push
        this.pendingIndex.set(job.id, job);
    }
    async pop() {
        const now = Date.now();
        const job = this.heap.extractMin(now);
        if (!job)
            return null;
        // fix: remove from index when popped from heap
        this.pendingIndex.delete(job.id);
        return job;
    }
    async peek() {
        const now = Date.now();
        const job = this.heap.peekMin(now);
        if (!job)
            return null;
        return job;
    }
    async get(id) {
        // fix: O(1) lookup via pendingIndex instead of O(n) heap.toArray().find()
        const inHeap = this.pendingIndex.get(id);
        if (inHeap)
            return inHeap;
        return this.store.get(id) ?? null;
    }
    async update(job) {
        // fix: update pendingIndex when job is still heap-pending
        if (this.pendingIndex.has(job.id)) {
            this.heap.update(job);
            this.pendingIndex.set(job.id, job);
        }
        else {
            this.store.set(job.id, job);
        }
    }
    async remove(id) {
        this.heap.remove(id);
        // fix: remove from index on explicit remove
        this.pendingIndex.delete(id);
        this.store.delete(id);
    }
    async size() {
        return this.heap.size;
    }
    async getAll() {
        const fromHeap = this.heap.toArray();
        const fromStore = Array.from(this.store.values());
        return [...fromHeap, ...fromStore];
    }
    async clear() {
        this.heap.clear();
        this.store.clear();
        // fix: clear index on full reset
        this.pendingIndex.clear();
    }
    async close() {
        await this.clear();
        // Suppress unused import
        void AdapterError_js_1.AdapterError;
    }
}
exports.MemoryAdapter = MemoryAdapter;
