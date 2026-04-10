/**
 * @module db/metrics-manager
 *
 * Manages metrics, version info, export, and backup operations.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */

import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
import type { OvnMetrics, OvnVersion, Document } from '../types/index.js';

/**
 * MetricsManager handles all observability and maintenance operations.
 */
export class MetricsManager {
  readonly #handle: () => number;

  /**
   * @param handle - Function that returns the native database handle
   */
  constructor(handle: () => number) {
    this.#handle = handle;
  }

  /**
   * Get database performance and storage metrics.
   */
  async getMetrics(): Promise<OvnMetrics> {
    const json = wrapNative(() => native.getMetrics(this.#handle()));
    return JSON.parse(json) as OvnMetrics;
  }

  /**
   * Get engine version information.
   */
  async getVersion(): Promise<OvnVersion> {
    const json = wrapNative(() => native.getVersion(this.#handle()));
    return JSON.parse(json) as OvnVersion;
  }

  /**
   * Export entire database as a JSON object.
   */
  async export(): Promise<Record<string, Document[]>> {
    const json = wrapNative(() => native.export(this.#handle()));
    return JSON.parse(json) as Record<string, Document[]>;
  }

  /**
   * Backup database to a JSON file.
   */
  async backup(destPath: string): Promise<void> {
    wrapNative(() => native.backup(this.#handle(), destPath));
  }

  /**
   * Force checkpoint — flush all dirty MemTable pages to disk.
   */
  async checkpoint(): Promise<void> {
    wrapNative(() => native.checkpoint(this.#handle()));
  }
}
