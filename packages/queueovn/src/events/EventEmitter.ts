import { EventEmitter as NodeEventEmitter } from 'events';
import type { QueueEventMap, QueueEventName, QueueEventArgs } from './QueueEvents.js';

/**
 * Typed EventEmitter wrapper.
 * Provides type-safe emit/on/off/once based on QueueEventMap.
 */
export class TypedEventEmitter {
    private readonly emitter = new NodeEventEmitter();

    on<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
        return this;
    }

    once<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this {
        this.emitter.once(event, listener as (...args: unknown[]) => void);
        return this;
    }

    off<K extends QueueEventName>(event: K, listener: (...args: QueueEventArgs<K>) => void): this {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
        return this;
    }

    emit<K extends QueueEventName>(event: K, ...args: QueueEventArgs<K>): boolean {
        return this.emitter.emit(event, ...args);
    }

    removeAllListeners(event?: QueueEventName): this {
        this.emitter.removeAllListeners(event);
        return this;
    }

    listenerCount(event: QueueEventName): number {
        return this.emitter.listenerCount(event);
    }

    setMaxListeners(n: number): this {
        this.emitter.setMaxListeners(n);
        return this;
    }
}

export type { QueueEventMap };
