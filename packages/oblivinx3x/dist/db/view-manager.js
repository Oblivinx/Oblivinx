/**
 * @module db/view-manager
 *
 * Manages view lifecycle: create, drop, list, refresh.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
/**
 * ViewManager handles all view-related operations.
 * Injected into Oblivinx3x via lazy getter.
 */
export class ViewManager {
    #handle;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle) {
        this.#handle = handle;
    }
    /**
     * Create a logical view — stored query that always reads live data.
     */
    async createView(name, definition) {
        wrapNative(() => native.createView(this.#handle(), name, JSON.stringify(definition)));
    }
    /**
     * Drop a view.
     */
    async dropView(name) {
        wrapNative(() => native.dropView(this.#handle(), name));
    }
    /**
     * List all views defined in the database.
     */
    async listViews() {
        const json = wrapNative(() => native.listViews(this.#handle()));
        return JSON.parse(json);
    }
    /**
     * Manually refresh a materialized view.
     */
    async refreshView(name) {
        wrapNative(() => native.refreshView(this.#handle(), name));
    }
}
//# sourceMappingURL=view-manager.js.map