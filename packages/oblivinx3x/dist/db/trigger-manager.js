/**
 * @module db/trigger-manager
 *
 * Manages trigger registration and execution on collections.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
/**
 * TriggerManager handles all trigger-related operations.
 * Stores handlers in-memory and delegates registration to native engine.
 */
export class TriggerManager {
    #handle;
    /** In-memory registry of trigger handlers: collection -> event -> handler[] */
    #handlers = new Map();
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle) {
        this.#handle = handle;
    }
    /**
     * Register a trigger on a collection for a specific event.
     */
    async createTrigger(collection, event, handler) {
        // Register in native engine
        wrapNative(() => native.createTrigger(this.#handle(), collection, event));
        // Store handler in JS registry
        if (!this.#handlers.has(collection)) {
            this.#handlers.set(collection, new Map());
        }
        const collectionHandlers = this.#handlers.get(collection);
        if (!collectionHandlers.has(event)) {
            collectionHandlers.set(event, []);
        }
        collectionHandlers.get(event).push(handler);
    }
    /**
     * Drop a trigger from a collection.
     */
    async dropTrigger(collection, event) {
        wrapNative(() => native.dropTrigger(this.#handle(), collection, event));
        // Remove from JS registry
        const collectionHandlers = this.#handlers.get(collection);
        if (collectionHandlers) {
            collectionHandlers.delete(event);
            if (collectionHandlers.size === 0) {
                this.#handlers.delete(collection);
            }
        }
    }
    /**
     * List all triggers on a collection.
     */
    async listTriggers(collection) {
        const json = wrapNative(() => native.listTriggers(this.#handle(), collection));
        return JSON.parse(json);
    }
    /**
     * Get registered handlers for a collection + event.
     * @internal
     */
    getHandlers(collection, event) {
        return this.#handlers.get(collection)?.get(event) ?? [];
    }
}
//# sourceMappingURL=trigger-manager.js.map