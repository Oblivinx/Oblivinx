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
// ═══════════════════════════════════════════════════════════════════════
// DIFF COMPUTATION
// ═══════════════════════════════════════════════════════════════════════
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
export function computeDiff(older, newer) {
    const added = {};
    const modified = {};
    const removed = {};
    const olderKeys = new Set(Object.keys(older));
    const newerKeys = new Set(Object.keys(newer));
    // Skip version metadata fields in diff
    const metaFields = new Set(['__version', '__versionedAt', '__author', '__tag', '_id']);
    // Find added and modified fields
    for (const key of newerKeys) {
        if (metaFields.has(key))
            continue;
        if (!olderKeys.has(key)) {
            added[key] = newer[key];
        }
        else if (!deepEqual(older[key], newer[key])) {
            modified[key] = { old: older[key], new: newer[key] };
        }
    }
    // Find removed fields
    for (const key of olderKeys) {
        if (metaFields.has(key))
            continue;
        if (!newerKeys.has(key)) {
            removed[key] = older[key];
        }
    }
    const changeCount = Object.keys(added).length
        + Object.keys(modified).length
        + Object.keys(removed).length;
    return { added, modified, removed, changeCount };
}
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
export function applyDiff(base, diff) {
    const result = { ...base };
    // Apply removals
    for (const key of Object.keys(diff.removed)) {
        delete result[key];
    }
    // Apply modifications
    for (const [key, fieldDiff] of Object.entries(diff.modified)) {
        result[key] = fieldDiff.new;
    }
    // Apply additions
    for (const [key, value] of Object.entries(diff.added)) {
        result[key] = value;
    }
    return result;
}
/**
 * Reverse a diff — creates the inverse diff that undoes the changes.
 *
 * @param diff - Forward diff
 * @returns Inverse diff (applying it to `newer` returns `older`)
 */
export function reverseDiff(diff) {
    const reversed = {
        added: { ...diff.removed },
        modified: {},
        removed: { ...diff.added },
        changeCount: diff.changeCount,
    };
    // Swap old/new in modified
    const modEntries = {};
    for (const [key, fieldDiff] of Object.entries(diff.modified)) {
        modEntries[key] = { old: fieldDiff.new, new: fieldDiff.old };
    }
    return { ...reversed, modified: modEntries };
}
// ═══════════════════════════════════════════════════════════════════════
// VERSION METADATA HELPERS
// ═══════════════════════════════════════════════════════════════════════
/**
 * Create version metadata for a document.
 *
 * @param version - Version number
 * @param author - Optional author ID
 * @param tag - Optional version tag
 * @returns VersionMetadata object
 */
export function createVersionMeta(version, author, tag) {
    const meta = {
        __version: version,
        __versionedAt: Date.now(),
        ...(author !== undefined ? { __author: author } : {}),
        ...(tag !== undefined ? { __tag: tag } : {}),
    };
    return meta;
}
/**
 * Attach version metadata to a document.
 *
 * @param doc - Original document
 * @param version - Version number
 * @param author - Optional author
 * @param tag - Optional tag
 * @returns Document with version metadata
 */
export function attachVersionMeta(doc, version, author, tag) {
    return {
        ...doc,
        ...createVersionMeta(version, author, tag),
    };
}
/**
 * Strip version metadata from a document to get the clean data.
 *
 * @param doc - Versioned document
 * @returns Clean document without version metadata
 */
export function stripVersionMeta(doc) {
    const result = { ...doc };
    delete result.__version;
    delete result.__versionedAt;
    delete result.__author;
    delete result.__tag;
    return result;
}
/**
 * Check if a document has version metadata.
 *
 * @param doc - Document to check
 * @returns true if document has __version field
 */
export function isVersioned(doc) {
    return '__version' in doc && typeof doc.__version === 'number';
}
// ═══════════════════════════════════════════════════════════════════════
// TIMELINE BUILDER
// ═══════════════════════════════════════════════════════════════════════
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
export function buildTimeline(versions) {
    return versions.map(v => ({
        version: v.version,
        createdAt: new Date(v.createdAt),
        author: v.author ?? undefined,
        tag: v.tag ?? undefined,
        changeCount: v.changeCount ?? 0,
    }));
}
// ═══════════════════════════════════════════════════════════════════════
// VERSIONING CONFIG BUILDER
// ═══════════════════════════════════════════════════════════════════════
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
export class VersioningConfigBuilder {
    #config = {};
    /** Start with diff mode (stores deltas, saves storage) */
    static diffMode() {
        const builder = new VersioningConfigBuilder();
        builder.#config.mode = 'diff';
        return builder;
    }
    /** Start with snapshot mode (stores full copies, faster reads) */
    static snapshotMode() {
        const builder = new VersioningConfigBuilder();
        builder.#config.mode = 'snapshot';
        return builder;
    }
    /** Set maximum versions retained per document */
    maxVersions(n) {
        this.#config.maxVersions = n;
        return this;
    }
    /** Set retention period (e.g. '30d', '90d', '1y') */
    retainFor(duration) {
        this.#config.retainFor = duration;
        return this;
    }
    /** Enable author tracking */
    trackAuthor(enabled = true) {
        this.#config.trackAuthor = enabled;
        return this;
    }
    /** Build the final VersioningConfig */
    build() {
        return { ...this.#config };
    }
}
// ═══════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════
/**
 * Deep equality check using JSON serialization.
 * Not the most performant but correct for document comparison.
 * @internal
 */
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return false;
    // Use JSON comparison for deep equality
    return JSON.stringify(a) === JSON.stringify(b);
}
//# sourceMappingURL=VersionedDocument.js.map