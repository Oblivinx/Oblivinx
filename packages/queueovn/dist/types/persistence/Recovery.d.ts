import type { IStorageAdapter } from '../types/adapter.types.js';
import { WALWriter } from './WALWriter.js';
import { Snapshot } from './Snapshot.js';
/**
 * Recovery — crash recovery orchestrator.
 * On startup: load snapshot → replay WAL → reset in-flight → rebuild heap.
 */
export declare class Recovery {
    private readonly walWriter;
    private readonly snapshot;
    private readonly adapter;
    constructor(walWriter: WALWriter, snapshot: Snapshot, adapter: IStorageAdapter);
    /**
     * Run the full recovery procedure.
     * Call this before starting workers.
     */
    run(): Promise<void>;
    private replayEntry;
}
