/**
 * Min-heap priority queue (O(log n) insert & extract-min).
 * Tiebreaker: lower priority number wins → then earlier runAt → then FIFO (insertedAt).
 *
 * Stored separately from the job map to keep the heap small and fast.
 */
export class PriorityHeap {
    heap = [];
    jobs = new Map();
    insertCounter = 0;
    /** Number of jobs currently in the heap */
    get size() {
        return this.heap.length;
    }
    /** Insert a job into the heap — O(log n) */
    insert(job) {
        const entry = {
            id: job.id,
            priority: job.priority,
            runAt: job.runAt,
            insertedAt: this.insertCounter++,
        };
        this.jobs.set(job.id, job);
        this.heap.push(entry);
        this.bubbleUp(this.heap.length - 1);
    }
    /**
     * Extract (remove and return) the highest-priority job whose runAt <= now.
     * Returns null if the heap is empty or no job is ready yet.
     */
    extractMin(now) {
        // Peek first — no point extracting if not ready
        if (this.heap.length === 0)
            return null;
        const top = this.heap[0];
        if (top.runAt > now)
            return null;
        this.swap(0, this.heap.length - 1);
        this.heap.pop();
        if (this.heap.length > 0)
            this.sinkDown(0);
        const job = this.jobs.get(top.id) ?? null;
        this.jobs.delete(top.id);
        return job;
    }
    /**
     * Peek at the top entry without modification.
     */
    peekMin(now) {
        if (this.heap.length === 0)
            return null;
        const top = this.heap[0];
        if (top.runAt > now)
            return null;
        return this.jobs.get(top.id) ?? null;
    }
    /** Update a job already in the heap (e.g. after state change) */
    update(job) {
        if (this.jobs.has(job.id)) {
            this.jobs.set(job.id, job);
        }
    }
    /** Remove a job by id — O(n) search then O(log n) re-heap */
    remove(id) {
        const idx = this.heap.findIndex((e) => e.id === id);
        if (idx === -1)
            return;
        this.swap(idx, this.heap.length - 1);
        this.heap.pop();
        this.jobs.delete(id);
        if (idx < this.heap.length) {
            this.bubbleUp(idx);
            this.sinkDown(idx);
        }
    }
    /** Return all jobs (for snapshot / recovery) */
    toArray() {
        return Array.from(this.jobs.values());
    }
    /** Clear the heap */
    clear() {
        this.heap = [];
        this.jobs.clear();
        this.insertCounter = 0;
    }
    // ─── Heap helpers ────────────────────────────────────────────────────────────
    compare(a, b) {
        // Lower priority value = more urgent
        if (a.priority !== b.priority)
            return a.priority < b.priority;
        // Earlier runAt = more urgent
        if (a.runAt !== b.runAt)
            return a.runAt < b.runAt;
        // FIFO tiebreaker
        return a.insertedAt < b.insertedAt;
    }
    swap(i, j) {
        const tmp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = tmp;
    }
    bubbleUp(i) {
        while (i > 0) {
            const parent = Math.floor((i - 1) / 2);
            if (this.compare(this.heap[i], this.heap[parent])) {
                this.swap(i, parent);
                i = parent;
            }
            else {
                break;
            }
        }
    }
    sinkDown(i) {
        const n = this.heap.length;
        while (true) {
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            let smallest = i;
            if (left < n && this.compare(this.heap[left], this.heap[smallest]))
                smallest = left;
            if (right < n && this.compare(this.heap[right], this.heap[smallest]))
                smallest = right;
            if (smallest !== i) {
                this.swap(i, smallest);
                i = smallest;
            }
            else {
                break;
            }
        }
    }
}
