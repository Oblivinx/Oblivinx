/**
 * @module db/attach-manager
 *
 * Manages attached database operations: attach, detach, list.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
/**
 * AttachManager handles all attached database operations.
 */
export class AttachManager {
    #handle;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle) {
        this.#handle = handle;
    }
    /**
     * Attach a .ovn file with an alias.
     */
    async attach(path, alias) {
        wrapNative(() => native.attach(this.#handle(), path, alias));
    }
    /**
     * Detach an attached database.
     */
    async detach(alias) {
        wrapNative(() => native.detach(this.#handle(), alias));
    }
    /**
     * List all attached databases.
     */
    async listAttached() {
        const json = wrapNative(() => native.listAttached(this.#handle()));
        return JSON.parse(json);
    }
}
//# sourceMappingURL=attach-manager.js.map