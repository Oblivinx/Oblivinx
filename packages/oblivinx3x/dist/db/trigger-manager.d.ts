/**
 * @module db/trigger-manager
 *
 * Manages trigger registration and execution on collections.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import type { TriggerEvent, TriggerInfo } from '../types/index.js';
/** Type for trigger handler functions */
export type TriggerHandler = (doc: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
/**
 * TriggerManager handles all trigger-related operations.
 * Stores handlers in-memory and delegates registration to native engine.
 */
export declare class TriggerManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Register a trigger on a collection for a specific event.
     */
    createTrigger(collection: string, event: TriggerEvent, handler: TriggerHandler): Promise<void>;
    /**
     * Drop a trigger from a collection.
     */
    dropTrigger(collection: string, event: TriggerEvent): Promise<void>;
    /**
     * List all triggers on a collection.
     */
    listTriggers(collection: string): Promise<TriggerInfo[]>;
    /**
     * Get registered handlers for a collection + event.
     * @internal
     */
    getHandlers(collection: string, event: TriggerEvent): TriggerHandler[];
}
//# sourceMappingURL=trigger-manager.d.ts.map