import type { JobPayload } from './job.types.js';

/** A single node in a DAG flow */
export interface FlowNode<T extends JobPayload = JobPayload> {
    type: string;
    payload: T;
    priority?: number;
    delay?: number;
    maxAttempts?: number;
    maxDuration?: number;
    ttl?: number;
    /** IDs of nodes this node depends on (must complete first) */
    dependsOn?: string[];
}

/** DAG configuration — a named map of nodes */
export interface DAGConfig {
    nodes: Record<string, FlowNode>;
}

/** Internal representation of a resolved DAG node */
export interface DAGNode {
    id: string;
    jobId: string;
    type: string;
    deps: string[];
    completedDeps: Set<string>;
}

/** Chain step — ordered list for simple A→B→C flows */
export type ChainStep<T extends JobPayload = JobPayload> = Omit<FlowNode<T>, 'dependsOn'>;
