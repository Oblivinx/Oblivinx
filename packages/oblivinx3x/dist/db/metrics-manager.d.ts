/**
 * @module db/metrics-manager
 *
 * Manages metrics, version info, export, and backup operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import type { OvnMetrics, OvnVersion, Document } from '../types/index.js';
/**
 * MetricsManager handles all observability and maintenance operations.
 */
export declare class MetricsManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Get database performance and storage metrics.
     */
    getMetrics(): Promise<OvnMetrics>;
    /**
     * Get engine version information.
     */
    getVersion(): Promise<OvnVersion>;
    /**
     * Export entire database as a JSON object.
     */
    export(): Promise<Record<string, Document[]>>;
    /**
     * Backup database to a JSON file.
     */
    backup(destPath: string): Promise<void>;
    /**
     * Force checkpoint — flush all dirty MemTable pages to disk.
     */
    checkpoint(): Promise<void>;
}
//# sourceMappingURL=metrics-manager.d.ts.map