/**
 * @module db/metrics-manager
 *
 * Manages metrics, version info, export, and backup operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
/**
 * MetricsManager handles all observability and maintenance operations.
 */
export class MetricsManager {
    #handle;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle) {
        this.#handle = handle;
    }
    /**
     * Get database performance and storage metrics.
     */
    async getMetrics() {
        const json = wrapNative(() => native.getMetrics(this.#handle()));
        return JSON.parse(json);
    }
    /**
     * Get engine version information.
     */
    async getVersion() {
        const json = wrapNative(() => native.getVersion(this.#handle()));
        return JSON.parse(json);
    }
    /**
     * Export entire database as a JSON object.
     */
    async export() {
        const json = wrapNative(() => native.export(this.#handle()));
        return JSON.parse(json);
    }
    /**
     * Backup database to a JSON file.
     */
    async backup(destPath) {
        wrapNative(() => native.backup(this.#handle(), destPath));
    }
    /**
     * Force checkpoint — flush all dirty MemTable pages to disk.
     */
    async checkpoint() {
        wrapNative(() => native.checkpoint(this.#handle()));
    }
}
//# sourceMappingURL=metrics-manager.js.map