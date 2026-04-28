import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from '../../../src/events/EventEmitter.js';
import { QueueEvent } from '../../../src/events/QueueEvents.js';

describe('TypedEventEmitter', () => {
    it('on / emit / off work correctly', () => {
        const emitter = new TypedEventEmitter();
        const listener = vi.fn();
        emitter.on(QueueEvent.ENQUEUED, listener);
        emitter.emit(QueueEvent.ENQUEUED, {} as never);
        expect(listener).toHaveBeenCalledOnce();
        emitter.off(QueueEvent.ENQUEUED, listener);
        emitter.emit(QueueEvent.ENQUEUED, {} as never);
        expect(listener).toHaveBeenCalledOnce(); // not called again
    });

    it('once fires only once', () => {
        const emitter = new TypedEventEmitter();
        const listener = vi.fn();
        emitter.once(QueueEvent.COMPLETED, listener);
        emitter.emit(QueueEvent.COMPLETED, {} as never, {} as never);
        emitter.emit(QueueEvent.COMPLETED, {} as never, {} as never);
        expect(listener).toHaveBeenCalledOnce();
    });

    it('removeAllListeners removes all listeners for an event', () => {
        const emitter = new TypedEventEmitter();
        const l1 = vi.fn();
        const l2 = vi.fn();
        emitter.on(QueueEvent.FAILED, l1);
        emitter.on(QueueEvent.FAILED, l2);
        expect(emitter.listenerCount(QueueEvent.FAILED)).toBe(2);
        emitter.removeAllListeners(QueueEvent.FAILED);
        expect(emitter.listenerCount(QueueEvent.FAILED)).toBe(0);
    });

    it('removeAllListeners with no args removes all event listeners', () => {
        const emitter = new TypedEventEmitter();
        emitter.on(QueueEvent.ENQUEUED, vi.fn());
        emitter.on(QueueEvent.COMPLETED, vi.fn());
        emitter.removeAllListeners(QueueEvent.ENQUEUED);
        emitter.removeAllListeners(QueueEvent.COMPLETED);
        expect(emitter.listenerCount(QueueEvent.ENQUEUED)).toBe(0);
        expect(emitter.listenerCount(QueueEvent.COMPLETED)).toBe(0);
    });

    it('listenerCount returns correct count', () => {
        const emitter = new TypedEventEmitter();
        expect(emitter.listenerCount(QueueEvent.ACTIVE)).toBe(0);
        emitter.on(QueueEvent.ACTIVE, vi.fn());
        expect(emitter.listenerCount(QueueEvent.ACTIVE)).toBe(1);
        emitter.on(QueueEvent.ACTIVE, vi.fn());
        expect(emitter.listenerCount(QueueEvent.ACTIVE)).toBe(2);
    });

    it('setMaxListeners does not throw', () => {
        const emitter = new TypedEventEmitter();
        expect(() => emitter.setMaxListeners(100)).not.toThrow();
    });
});
