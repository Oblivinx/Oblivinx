/**
 * @module db/pragma-manager
 *
 * Manages pragma (engine directive) get/set operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
/**
 * PragmaManager handles all pragma-related operations.
 * Pragmas persist across sessions in the Metadata Segment.
 */
export class PragmaManager {
    #handle;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle) {
        this.#handle = handle;
    }
    /**
     * Set a pragma value.
     */
    async setPragma(name, value) {
        wrapNative(() => native.setPragma(this.#handle(), name, JSON.stringify(value)));
    }
    /**
     * Read a pragma value.
     */
    async getPragma(name) {
        const json = wrapNative(() => native.getPragma(this.#handle(), name));
        return JSON.parse(json);
    }
}
//# sourceMappingURL=pragma-manager.js.map