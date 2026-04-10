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
import type { ViewInfo, PipelineStage } from '../types/index.js';

/**
 * ViewManager handles all view-related operations.
 * Injected into Oblivinx3x via lazy getter.
 */
export class ViewManager {
  readonly #handle: () => number;

  /**
   * @param handle - Function that returns the native database handle
   */
  constructor(handle: () => number) {
    this.#handle = handle;
  }

  /**
   * Create a logical view — stored query that always reads live data.
   */
  async createView(name: string, definition: {
    source: string;
    pipeline: PipelineStage[];
    materializedOptions?: {
      refresh: 'on_write' | 'scheduled' | 'manual';
      schedule?: string;
      maxSize?: string;
    };
  }): Promise<void> {
    wrapNative(() =>
      native.createView(this.#handle(), name, JSON.stringify(definition)),
    );
  }

  /**
   * Drop a view.
   */
  async dropView(name: string): Promise<void> {
    wrapNative(() => native.dropView(this.#handle(), name));
  }

  /**
   * List all views defined in the database.
   */
  async listViews(): Promise<ViewInfo[]> {
    const json = wrapNative(() => native.listViews(this.#handle()));
    return JSON.parse(json) as ViewInfo[];
  }

  /**
   * Manually refresh a materialized view.
   */
  async refreshView(name: string): Promise<void> {
    wrapNative(() => native.refreshView(this.#handle(), name));
  }
}
