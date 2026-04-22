/**
 * @file VersionedDocument.ts
 * @module oblivinx3x/versioning
 * @description
 *   TypeScript-layer utilities for the document versioning system.
 *   Provides stateless helper functions for diff computation,
 *   snapshot management, version metadata creation, and tag utilities.
 *
 *   These utilities work with the Collection-level versioning API
 *   (enableVersioning, listVersions, getVersion, diffVersions, etc.)
 *   to provide a higher-level TypeScript-friendly interface.
 *
 * @architecture
 *   Pattern: Utility Module (pure functions + type definitions)
 *   Ref: Section 4.1 (Versioned Document System)
 *
 * @example
 * ```typescript
 * import { computeDiff, applyDiff, createVersionMeta } from 'oblivinx3x';
 *
 * const v1 = { name: 'Alice', age: 28 };
 * const v2 = { name: 'Alice', age: 29, role: 'admin' };
 *
 * const diff = computeDiff(v1, v2);
 * // { added: { role: 'admin' }, modified: { age: { old: 28, new: 29 } }, removed: {} }
 *
 * const restored = applyDiff(v1, diff);
 * // { name: 'Alice', age: 29, role: 'admin' }
 * ```
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */
import type { Document, VersionInfo, VersioningConfig } from '../types/index.js';
/** Version metadata attached to a versioned document */
export interface VersionMetadata {
    /** Version number (1-based) */
    readonly __version: number;
    /** Timestamp when this version was created (Unix epoch ms) */
    readonly __versionedAt: number;
    /** Author who created this version (if trackAuthor is enabled) */
    readonly __author?: string;
    /** Tag label (if version was tagged) */
    readonly __tag?: string;
}
/** Document with version metadata attached */
export type VersionedDoc<T extends Document = Document> = T & VersionMetadata;
/** Diff detail for a single modified field */
export interface FieldDiff {
    /** Old value */
    readonly old: unknown;
    /** New value */
    readonly new: unknown;
}
/** Complete diff between two document versions */
export interface DocumentDiff {
    /** Fields added in the newer version */
    readonly added: Record<string, unknown>;
    /** Fields modified between versions */
    readonly modified: Record<string, FieldDiff>;
    /** Fields removed in the newer version */
    readonly removed: Record<string, unknown>;
    /** Total number of changes */
    readonly changeCount: number;
}
/** Version timeline entry for display/visualization */
export interface TimelineEntry {
    /** Version number */
    readonly version: number;
    /** When created */
    readonly createdAt: Date;
    /** Author (if available) */
    readonly author?: string;
    /** Tag (if tagged) */
    readonly tag?: string;
    /** Number of fields changed */
    readonly changeCount: number;
}
/**
 * Compute a detailed diff between two document snapshots.
 *
 * Performs a shallow comparison of top-level keys. For nested objects,
 * uses JSON equality (deep comparison via serialization).
 *
 * @param older - The older document version
 * @param newer - The newer document version
 * @returns DocumentDiff with added, modified, and removed fields
 *
 * @example
 * ```typescript
 * const v1 = { name: 'Alice', age: 28, city: 'Jakarta' };
 * const v2 = { name: 'Alice', age: 29, role: 'admin' };
 *
 * const diff = computeDiff(v1, v2);
 * // diff.added = { role: 'admin' }
 * // diff.modified = { age: { old: 28, new: 29 } }
 * // diff.removed = { city: 'Jakarta' }
 * // diff.changeCount = 3
 * ```
 */
export declare function computeDiff(older: Document, newer: Document): DocumentDiff;
/**
 * Apply a diff to a document to reconstruct the newer version.
 *
 * @param base - Base document (older version)
 * @param diff - Diff to apply
 * @returns Reconstructed document (newer version)
 *
 * @example
 * ```typescript
 * const v1 = { name: 'Alice', age: 28, city: 'Jakarta' };
 * const diff = computeDiff(v1, v2);
 * const v2Restored = applyDiff(v1, diff);
 * ```
 */
export declare function applyDiff<T extends Document>(base: T, diff: DocumentDiff): T;
/**
 * Reverse a diff — creates the inverse diff that undoes the changes.
 *
 * @param diff - Forward diff
 * @returns Inverse diff (applying it to `newer` returns `older`)
 */
export declare function reverseDiff(diff: DocumentDiff): DocumentDiff;
/**
 * Create version metadata for a document.
 *
 * @param version - Version number
 * @param author - Optional author ID
 * @param tag - Optional version tag
 * @returns VersionMetadata object
 */
export declare function createVersionMeta(version: number, author?: string, tag?: string): VersionMetadata;
/**
 * Attach version metadata to a document.
 *
 * @param doc - Original document
 * @param version - Version number
 * @param author - Optional author
 * @param tag - Optional tag
 * @returns Document with version metadata
 */
export declare function attachVersionMeta<T extends Document>(doc: T, version: number, author?: string, tag?: string): VersionedDoc<T>;
/**
 * Strip version metadata from a document to get the clean data.
 *
 * @param doc - Versioned document
 * @returns Clean document without version metadata
 */
export declare function stripVersionMeta<T extends Document>(doc: VersionedDoc<T>): T;
/**
 * Check if a document has version metadata.
 *
 * @param doc - Document to check
 * @returns true if document has __version field
 */
export declare function isVersioned(doc: Document): doc is VersionedDoc;
/**
 * Build a human-readable timeline from VersionInfo array.
 *
 * @param versions - Array of VersionInfo from `collection.listVersions()`
 * @returns Array of TimelineEntry sorted oldest → newest
 *
 * @example
 * ```typescript
 * const versions = await users.listVersions('user-123');
 * const timeline = buildTimeline(versions);
 * for (const entry of timeline) {
 *   console.log(`v${entry.version} at ${entry.createdAt.toISOString()}`);
 * }
 * ```
 */
export declare function buildTimeline(versions: VersionInfo[]): TimelineEntry[];
/**
 * Builder for VersioningConfig with sensible defaults.
 *
 * @example
 * ```typescript
 * const config = VersioningConfigBuilder
 *   .diffMode()
 *   .maxVersions(100)
 *   .retainFor('90d')
 *   .trackAuthor()
 *   .build();
 *
 * await users.enableVersioning(config);
 * ```
 */
export declare class VersioningConfigBuilder {
    #private;
    /** Start with diff mode (stores deltas, saves storage) */
    static diffMode(): VersioningConfigBuilder;
    /** Start with snapshot mode (stores full copies, faster reads) */
    static snapshotMode(): VersioningConfigBuilder;
    /** Set maximum versions retained per document */
    maxVersions(n: number): this;
    /** Set retention period (e.g. '30d', '90d', '1y') */
    retainFor(duration: string): this;
    /** Enable author tracking */
    trackAuthor(enabled?: boolean): this;
    /** Build the final VersioningConfig */
    build(): VersioningConfig;
}
//# sourceMappingURL=VersionedDocument.d.ts.map