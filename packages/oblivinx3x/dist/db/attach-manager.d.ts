/**
 * @module db/attach-manager
 *
 * Manages attached database operations: attach, detach, list.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import type { AttachedDatabaseInfo } from '../types/index.js';
/**
 * AttachManager handles all attached database operations.
 */
export declare class AttachManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Attach a .ovn file with an alias.
     */
    attach(path: string, alias: string): Promise<void>;
    /**
     * Detach an attached database.
     */
    detach(alias: string): Promise<void>;
    /**
     * List all attached databases.
     */
    listAttached(): Promise<AttachedDatabaseInfo[]>;
}
//# sourceMappingURL=attach-manager.d.ts.map