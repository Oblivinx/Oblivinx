import { EventEmitter as NodeEventEmitter } from 'events';
/**
 * Typed EventEmitter wrapper.
 * Provides type-safe emit/on/off/once based on QueueEventMap.
 */
export class TypedEventEmitter {
    emitter = new NodeEventEmitter();
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    emit(event, ...args) {
        return this.emitter.emit(event, ...args);
    }
    removeAllListeners(event) {
        this.emitter.removeAllListeners(event);
        return this;
    }
    listenerCount(event) {
        return this.emitter.listenerCount(event);
    }
    setMaxListeners(n) {
        this.emitter.setMaxListeners(n);
        return this;
    }
}
