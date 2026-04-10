/**
 * @module db/pragma-manager
 *
 * Manages pragma (engine directive) get/set operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import type { PragmaName, PragmaValue } from '../types/index.js';
/**
 * PragmaManager handles all pragma-related operations.
 * Pragmas persist across sessions in the Metadata Segment.
 */
export declare class PragmaManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Set a pragma value.
     */
    setPragma(name: PragmaName, value: PragmaValue): Promise<void>;
    /**
     * Read a pragma value.
     */
    getPragma(name: PragmaName): Promise<PragmaValue>;
}
//# sourceMappingURL=pragma-manager.d.ts.map