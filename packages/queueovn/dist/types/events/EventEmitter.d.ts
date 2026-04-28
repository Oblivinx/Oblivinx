import type { QueueEventMap, QueueEventName, QueueEventArgs } from './QueueEvents.js';
/**
 * Typed EventEmitter wrapper.
 * Provides type-safe emit/on/off/once based on QueueEventMap.
 */
export declare class TypedEventEmitter {
    private readonly emitter;
    on<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this;
    once<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this;
    off<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this;
    emit<K extends QueueEventName>(event: K, ...args: QueueEventArgs<K>): boolean;
    removeAllListeners(event?: QueueEventName): this;
    listenerCount(event: QueueEventName): number;
    setMaxListeners(n: number): this;
}
export type { QueueEventMap };
