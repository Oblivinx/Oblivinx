/**
 * @module db/blob-manager
 *
 * Manages blob (binary large object) storage operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
/**
 * BlobManager handles all blob-related operations.
 */
export declare class BlobManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Store a binary blob natively.
     *
     * @param data - Binary data to store
     * @returns UUID string of the stored blob
     */
    putBlob(data: Uint8Array): Promise<string>;
    /**
     * Retrieve a binary blob by UUID.
     *
     * @param blobId - UUID of the blob
     * @returns Binary data or null if not found
     */
    getBlob(blobId: string): Promise<Uint8Array | null>;
}
//# sourceMappingURL=blob-manager.d.ts.map