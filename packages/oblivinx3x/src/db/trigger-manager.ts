/**
 * @module db/trigger-manager
 *
 * Manages trigger registration and execution on collections.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */

import { native } from '../loader.js';
import { wrapNative } from '../errors/index.js';
import type { TriggerEvent, TriggerInfo } from '../types/index.js';

/** Type for trigger handler functions */
export type TriggerHandler = (doc: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * TriggerManager handles all trigger-related operations.
 * Stores handlers in-memory and delegates registration to native engine.
 */
export class TriggerManager {
  readonly #handle: () => number;

  /** In-memory registry of trigger handlers: collection -> event -> handler[] */
  readonly #handlers = new Map<string, Map<TriggerEvent, TriggerHandler[]>>();

  /**
   * @param handle - Function that returns the native database handle
   */
  constructor(handle: () => number) {
    this.#handle = handle;
  }

  /**
   * Register a trigger on a collection for a specific event.
   */
  async createTrigger(
    collection: string,
    event: TriggerEvent,
    handler: TriggerHandler,
  ): Promise<void> {
    // Register in native engine
    wrapNative(() =>
      native.createTrigger(this.#handle(), collection, event),
    );

    // Store handler in JS registry
    if (!this.#handlers.has(collection)) {
      this.#handlers.set(collection, new Map());
    }
    const collectionHandlers = this.#handlers.get(collection)!;
    if (!collectionHandlers.has(event)) {
      collectionHandlers.set(event, []);
    }
    collectionHandlers.get(event)!.push(handler);
  }

  /**
   * Drop a trigger from a collection.
   */
  async dropTrigger(collection: string, event: TriggerEvent): Promise<void> {
    wrapNative(() => native.dropTrigger(this.#handle(), collection, event));

    // Remove from JS registry
    const collectionHandlers = this.#handlers.get(collection);
    if (collectionHandlers) {
      collectionHandlers.delete(event);
      if (collectionHandlers.size === 0) {
        this.#handlers.delete(collection);
      }
    }
  }

  /**
   * List all triggers on a collection.
   */
  async listTriggers(collection: string): Promise<TriggerInfo[]> {
    const json = wrapNative(() => native.listTriggers(this.#handle(), collection));
    return JSON.parse(json) as TriggerInfo[];
  }

  /**
   * Get registered handlers for a collection + event.
   * @internal
   */
  getHandlers(collection: string, event: TriggerEvent): TriggerHandler[] {
    return this.#handlers.get(collection)?.get(event) ?? [];
  }
}
