import { createJob, updateJob } from '../job/Job.js';
import { JobState } from '../job/JobState.js';
import { CyclicDependencyError } from '../errors/DependencyError.js';
import { generateId } from '../utils/idGenerator.js';
const DAG_DEFAULTS = {
    defaultPriority: 5,
    defaultMaxAttempts: 3,
    defaultMaxDuration: 30_000,
};
/**
 * FlowController — manages job chaining (A→B→C) and DAG dependency graphs.
 */
export class FlowController {
    adapter;
    // feat: optional WAL reference for persisting chain/DAG state
    wal;
    // fix: callback to wake up idle workers after any adapter.push inside FlowController
    onJobPushed;
    /** nodeId → DAGNode for all in-flight DAG nodes */
    dagNodes = new Map();
    /** nodeId → jobId mapping */
    nodeToJob = new Map();
    // fix: reverse map jobId → nodeId so unlockDAGDependents can resolve UUID → node key
    jobToNode = new Map();
    /** chain metadata store */
    chainMap = new Map();
    // update: wal param added for crash-safe state persistence
    // fix: onJobPushed callback added so chain/DAG adapter pushes wake up idle workers
    constructor(adapter, wal = null, onJobPushed = () => { }) {
        this.adapter = adapter;
        this.wal = wal;
        this.onJobPushed = onJobPushed;
        // Suppress unused import warning
        void JobState;
    }
    /**
     * Enqueue a simple ordered chain: A → B → C
     * Returns the flowId.
     */
    async chain(steps) {
        if (steps.length === 0)
            return generateId();
        const flowId = generateId();
        const firstStep = steps[0];
        const job = createJob({ ...firstStep, flowId }, DAG_DEFAULTS);
        this.chainMap.set(flowId, { steps, currentIndex: 0 });
        // feat: persist chain registration so it survives crashes
        this.wal?.append('CHAIN_REGISTER', flowId, { steps, currentIndex: 0 });
        await this.adapter.push(job);
        // fix: wake up idle workers so the chain's first job is picked up immediately
        this.onJobPushed();
        return flowId;
    }
    /**
     * Called by the queue when a job completes.
     * Triggers the next step in a chain, or unlocks DAG dependents.
     */
    async onJobComplete(job) {
        if (job.flowId && this.chainMap.has(job.flowId)) {
            await this.advanceChain(job.flowId);
            // fix: use else-if so the last chain step (which removes itself from chainMap
            // inside advanceChain) does NOT fall through to the DAG unlock path
        }
        else if (job.flowId) {
            await this.unlockDAGDependents(job.id);
        }
    }
    /**
     * Called by the queue when a job fails permanently.
     * Cancels all downstream dependents.
     */
    onJobFail(job) {
        if (job.flowId && this.chainMap.has(job.flowId)) {
            this.chainMap.delete(job.flowId);
            // feat: persist chain removal on failure
            this.wal?.append('CHAIN_COMPLETE', job.flowId);
        }
        // fix: cancelDownstream is now async BFS — no longer throws
        this.cancelDownstream(job.id).catch(() => { });
    }
    /**
     * Enqueue a DAG configuration.
     * Performs topological sort (Kahn's algorithm), validates for cycles.
     * Returns flowId.
     */
    async dag(config) {
        const flowId = generateId();
        const nodeIds = Object.keys(config.nodes);
        const inDegree = new Map();
        const adj = new Map();
        for (const id of nodeIds) {
            inDegree.set(id, 0);
            adj.set(id, []);
        }
        for (const [id, node] of Object.entries(config.nodes)) {
            for (const dep of node.dependsOn ?? []) {
                adj.get(dep).push(id);
                inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
            }
        }
        // Kahn's topological sort — detects cycles
        const queue = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0)
                queue.push(id);
        }
        const order = [];
        while (queue.length > 0) {
            const cur = queue.shift();
            order.push(cur);
            for (const neighbor of adj.get(cur) ?? []) {
                const newDeg = inDegree.get(neighbor) - 1;
                inDegree.set(neighbor, newDeg);
                if (newDeg === 0)
                    queue.push(neighbor);
            }
        }
        if (order.length !== nodeIds.length) {
            throw new CyclicDependencyError(nodeIds);
        }
        for (const [id, node] of Object.entries(config.nodes)) {
            const jobId = generateId();
            const dagNode = {
                id,
                jobId,
                type: node.type,
                deps: node.dependsOn ?? [],
                completedDeps: new Set(),
            };
            this.dagNodes.set(id, dagNode);
            this.nodeToJob.set(id, jobId);
            // fix: register in reverse map so onJobComplete can resolve UUID → nodeId
            this.jobToNode.set(jobId, id);
        }
        // feat: persist DAG registration (serialize Set → Array for JSON)
        const serializedNodes = {};
        for (const [nodeId, dagNode] of this.dagNodes) {
            serializedNodes[nodeId] = {
                id: dagNode.id,
                jobId: dagNode.jobId,
                type: dagNode.type,
                deps: dagNode.deps,
                completedDeps: [],
            };
        }
        this.wal?.append('DAG_REGISTER', flowId, { flowId, nodes: serializedNodes });
        for (const [id, node] of Object.entries(config.nodes)) {
            if ((node.dependsOn ?? []).length === 0) {
                const dagNode = this.dagNodes.get(id);
                const job = createJob({ ...node, flowId, dependsOn: [] }, DAG_DEFAULTS);
                const remapped = updateJob(job, { flowId });
                // fix: update reverse map to point at the remapped job id
                this.jobToNode.delete(dagNode.jobId);
                this.jobToNode.set(remapped.id, id);
                this.dagNodes.set(id, { ...dagNode, jobId: remapped.id });
                await this.adapter.push(remapped);
                // fix: wake up idle workers for each root DAG job pushed
                this.onJobPushed();
            }
        }
        return flowId;
    }
    /**
     * Restore chain/DAG state from WAL entries after crash recovery.
     * Call this after Recovery.run() during queue initialization.
     */
    // feat: WAL replay to rebuild chainMap and dagNodes after process restart
    restoreFromWAL(entries) {
        for (const entry of entries) {
            switch (entry.op) {
                case 'CHAIN_REGISTER': {
                    const data = entry.data;
                    if (data?.steps) {
                        this.chainMap.set(entry.jobId, {
                            steps: data.steps,
                            currentIndex: data.currentIndex ?? 0,
                        });
                    }
                    break;
                }
                case 'CHAIN_ADVANCE': {
                    const data = entry.data;
                    const chain = this.chainMap.get(entry.jobId);
                    if (chain && data?.currentIndex !== undefined) {
                        chain.currentIndex = data.currentIndex;
                    }
                    break;
                }
                case 'CHAIN_COMPLETE': {
                    this.chainMap.delete(entry.jobId);
                    break;
                }
                case 'DAG_REGISTER': {
                    const data = entry.data;
                    if (data?.nodes) {
                        for (const [nodeId, sNode] of Object.entries(data.nodes)) {
                            this.dagNodes.set(nodeId, {
                                id: sNode.id,
                                jobId: sNode.jobId,
                                type: sNode.type,
                                deps: sNode.deps,
                                completedDeps: new Set(sNode.completedDeps),
                            });
                            this.nodeToJob.set(nodeId, sNode.jobId);
                            // fix: restore reverse map on WAL replay
                            this.jobToNode.set(sNode.jobId, nodeId);
                        }
                    }
                    break;
                }
                case 'DAG_COMPLETE_DEP': {
                    const data = entry.data;
                    if (data?.nodeId) {
                        const dagNode = this.dagNodes.get(data.nodeId);
                        if (dagNode) {
                            dagNode.completedDeps.add(data.completedJobId);
                        }
                    }
                    break;
                }
            }
        }
    }
    // ─── Private helpers ──────────────────────────────────────────────────────────
    async advanceChain(flowId) {
        const flow = this.chainMap.get(flowId);
        if (!flow)
            return;
        const nextIndex = flow.currentIndex + 1;
        if (nextIndex >= flow.steps.length) {
            this.chainMap.delete(flowId);
            // feat: persist chain completion
            this.wal?.append('CHAIN_COMPLETE', flowId);
            return;
        }
        const nextStep = flow.steps[nextIndex];
        flow.currentIndex = nextIndex;
        // feat: persist chain advancement for recovery
        this.wal?.append('CHAIN_ADVANCE', flowId, { currentIndex: nextIndex });
        const job = createJob({ ...nextStep, flowId }, DAG_DEFAULTS);
        await this.adapter.push(job);
        // fix: wake up idle workers for each chain step advanced
        this.onJobPushed();
    }
    // fix: resolve completedJobId → nodeId via reverse map, then match by node key (not UUID)
    async unlockDAGDependents(completedJobId) {
        const completedNodeId = this.jobToNode.get(completedJobId);
        if (!completedNodeId)
            return; // not a tracked DAG job
        this.jobToNode.delete(completedJobId);
        for (const [nodeId, dagNode] of this.dagNodes) {
            if (dagNode.deps.includes(completedNodeId)) {
                dagNode.completedDeps.add(completedNodeId);
                // feat: persist dep completion for crash safety
                this.wal?.append('DAG_COMPLETE_DEP', nodeId, {
                    nodeId,
                    completedJobId: completedNodeId,
                });
                if (dagNode.completedDeps.size === dagNode.deps.length) {
                    const job = createJob({ type: dagNode.type, payload: {}, flowId: nodeId }, DAG_DEFAULTS);
                    this.dagNodes.delete(nodeId);
                    this.nodeToJob.delete(nodeId);
                    // fix: register the newly created job in the reverse map before pushing
                    this.jobToNode.set(job.id, nodeId);
                    await this.adapter.push(job);
                    // fix: wake up idle workers for each unlocked DAG node
                    this.onJobPushed();
                }
            }
        }
    }
    // fix: BFS cascade — no longer throws inside loop, actually removes downstream from adapter
    async cancelDownstream(failedNodeId) {
        const visited = new Set();
        const bfsQueue = [failedNodeId];
        while (bfsQueue.length > 0) {
            const current = bfsQueue.shift();
            for (const [nodeId, dagNode] of this.dagNodes) {
                if (dagNode.deps.includes(current) && !visited.has(nodeId)) {
                    visited.add(nodeId);
                    bfsQueue.push(nodeId);
                    this.dagNodes.delete(nodeId);
                    this.nodeToJob.delete(nodeId);
                    this.jobToNode.delete(dagNode.jobId);
                    // fix: actually cancel the downstream job in the adapter
                    await this.adapter.remove(dagNode.jobId).catch(() => { });
                }
            }
        }
    }
}
