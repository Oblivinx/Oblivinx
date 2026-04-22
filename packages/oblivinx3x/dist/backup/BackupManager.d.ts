/**
 * @file BackupManager.ts
 * @module oblivinx3x/backup
 * @description
 *   Backup & Recovery system for Oblivinx3x.
 *   Supports full binary backup, logical (JSON) export/import,
 *   incremental backups, verification, and point-in-time restore.
 *
 * @architecture
 *   Pattern: Manager — delegates heavy lifting to native engine.
 *   Full/incremental backups produce `.ovnbak` binary files.
 *   Logical export/import uses JSON streams for portability.
 *
 *   Ref: Section 11 (Backup & Recovery)
 *
 * @example
 * ```typescript
 * const backup = new BackupManager(db);
 *
 * // Full backup
 * const info = await backup.createFull('./backups/daily.ovnbak');
 * console.log(`Backup completed: ${info.sizeBytes} bytes`);
 *
 * // Logical export
 * await backup.exportLogical('./exports/data.json');
 *
 * // Verify
 * const valid = await backup.verify('./backups/daily.ovnbak');
 * ```
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */
import type { Oblivinx3x } from '../database.js';
/** Backup metadata */
export interface BackupInfo {
    /** Absolute path to the backup file */
    readonly path: string;
    /** Backup type */
    readonly type: 'full' | 'incremental' | 'logical';
    /** Timestamp when backup was created (ISO 8601) */
    readonly createdAt: string;
    /** Size in bytes */
    readonly sizeBytes: number;
    /** Number of collections included */
    readonly collectionCount: number;
    /** Total document count across all collections */
    readonly documentCount: number;
    /** Duration in milliseconds */
    readonly durationMs: number;
}
/** Restore progress callback */
export type RestoreProgressCallback = (progress: {
    phase: 'reading' | 'validating' | 'restoring' | 'indexing' | 'complete';
    current: number;
    total: number;
    collection?: string;
}) => void;
/** Backup prune policy */
export interface PrunePolicy {
    /** Keep at most N backups */
    maxCount?: number;
    /** Keep backups newer than N days */
    maxAgeDays?: number;
}
/**
 * BackupManager — manages backup, restore, export, import, and verification
 * for an Oblivinx3x database.
 *
 * @example
 * ```typescript
 * const db = new Oblivinx3x('data.ovn');
 * const mgr = new BackupManager(db);
 *
 * // Create a full binary backup
 * const info = await mgr.createFull('./backups/full.ovnbak');
 *
 * // Export as portable JSON
 * await mgr.exportLogical('./exports/dump.json');
 *
 * // Prune old backups, keep last 5
 * await mgr.prune('./backups/', { maxCount: 5 });
 * ```
 */
export declare class BackupManager {
    #private;
    /**
     * @param db - Database instance to manage backups for
     */
    constructor(db: Oblivinx3x);
    /**
     * Create a full binary backup of the database.
     *
     * Produces an `.ovnbak` file that contains a consistent snapshot
     * of all collections, indexes, and metadata. Uses native `backup()`.
     *
     * @param destPath - Destination file path (should end with .ovnbak)
     * @returns BackupInfo with metadata about the created backup
     *
     * @example
     * ```typescript
     * const info = await mgr.createFull('./backups/2024-01-15-full.ovnbak');
     * console.log(`Backup size: ${(info.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
     * ```
     */
    createFull(destPath: string): Promise<BackupInfo>;
    /**
     * Create an incremental backup (WAL-based, since last checkpoint).
     *
     * ⚠️ Requires native WAL incremental support. Falls back to full
     * backup if incremental is not available in the current engine version.
     *
     * @param destPath - Destination file path
     * @returns BackupInfo
     */
    createIncremental(destPath: string): Promise<BackupInfo>;
    /**
     * Export the entire database as a JSON file (portable logical backup).
     *
     * Format: `{ "collectionName": [doc1, doc2, ...], ... }`
     * Suitable for cross-platform migration, data analysis, or debugging.
     *
     * @param destPath - Destination JSON file path
     * @returns BackupInfo
     *
     * @example
     * ```typescript
     * await mgr.exportLogical('./exports/dump-2024-01-15.json');
     * ```
     */
    exportLogical(destPath: string): Promise<BackupInfo>;
    /**
     * Import data from a logical JSON export into the current database.
     *
     * @param sourcePath - Path to JSON export file
     * @param options - Import options
     * @returns Import statistics
     *
     * @example
     * ```typescript
     * const stats = await mgr.importLogical('./exports/dump.json', { dropExisting: true });
     * console.log(`Imported ${stats.documentCount} documents`);
     * ```
     */
    importLogical(sourcePath: string, options?: {
        dropExisting?: boolean;
    }): Promise<{
        collectionCount: number;
        documentCount: number;
    }>;
    /**
     * Verify a backup file's integrity.
     *
     * For binary backups: checks file header, CRC checksums, and page integrity.
     * For logical backups: validates JSON structure and document shapes.
     *
     * @param backupPath - Path to backup file to verify
     * @returns Verification result
     *
     * @example
     * ```typescript
     * const result = await mgr.verify('./backups/full.ovnbak');
     * if (result.valid) {
     *   console.log('Backup is valid');
     * } else {
     *   console.error('Issues:', result.issues);
     * }
     * ```
     */
    verify(backupPath: string): Promise<{
        valid: boolean;
        sizeBytes: number;
        issues: string[];
    }>;
    /**
     * List all backups in a directory.
     *
     * @param backupDir - Directory to scan for .ovnbak and .json files
     * @returns Array of backup file info, sorted newest first
     */
    list(backupDir: string): Promise<Array<{
        path: string;
        type: 'full' | 'logical';
        sizeBytes: number;
        createdAt: Date;
    }>>;
    /**
     * Prune old backups according to a retention policy.
     *
     * @param backupDir - Directory containing backup files
     * @param policy - Retention policy
     * @returns Number of files deleted
     *
     * @example
     * ```typescript
     * // Keep last 5 backups
     * const deleted = await mgr.prune('./backups/', { maxCount: 5 });
     *
     * // Keep backups from last 30 days
     * const deleted2 = await mgr.prune('./backups/', { maxAgeDays: 30 });
     * ```
     */
    prune(backupDir: string, policy: PrunePolicy): Promise<number>;
}
//# sourceMappingURL=BackupManager.d.ts.map