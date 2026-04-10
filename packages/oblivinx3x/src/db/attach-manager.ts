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
import type { AttachedDatabaseInfo } from '../types/index.js';

/**
 * AttachManager handles all attached database operations.
 */
export class AttachManager {
  readonly #handle: () => number;

  /**
   * @param handle - Function that returns the native database handle
   */
  constructor(handle: () => number) {
    this.#handle = handle;
  }

  /**
   * Attach a .ovn file with an alias.
   */
  async attach(path: string, alias: string): Promise<void> {
    wrapNative(() => native.attach(this.#handle(), path, alias));
  }

  /**
   * Detach an attached database.
   */
  async detach(alias: string): Promise<void> {
    wrapNative(() => native.detach(this.#handle(), alias));
  }

  /**
   * List all attached databases.
   */
  async listAttached(): Promise<AttachedDatabaseInfo[]> {
    const json = wrapNative(() => native.listAttached(this.#handle()));
    return JSON.parse(json) as AttachedDatabaseInfo[];
  }
}
