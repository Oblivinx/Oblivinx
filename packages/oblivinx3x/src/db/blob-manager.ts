/**
 * @module db/blob-manager
 *
 * Manages blob (binary large object) storage operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */

import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';

/**
 * BlobManager handles all blob-related operations.
 */
export class BlobManager {
  readonly #handle: () => number;

  /**
   * @param handle - Function that returns the native database handle
   */
  constructor(handle: () => number) {
    this.#handle = handle;
  }

  /**
   * Store a binary blob natively.
   *
   * @param data - Binary data to store
   * @returns UUID string of the stored blob
   */
  async putBlob(data: Uint8Array): Promise<string> {
    return wrapNative(() => native.putBlob(this.#handle(), data));
  }

  /**
   * Retrieve a binary blob by UUID.
   *
   * @param blobId - UUID of the blob
   * @returns Binary data or null if not found
   */
  async getBlob(blobId: string): Promise<Uint8Array | null> {
    return wrapNative(() => native.getBlob(this.#handle(), blobId));
  }
}
