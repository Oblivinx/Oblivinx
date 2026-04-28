import { describe, it, expect } from 'vitest';
import { JobRegistry } from '../../../src/core/JobRegistry.js';
import { UnknownJobTypeError } from '../../../src/errors/DependencyError.js';

describe('JobRegistry', () => {
    it('register and lookup a handler', () => {
        const registry = new JobRegistry();
        const handler = async () => 'ok';
        registry.register('test', handler);
        expect(registry.lookup('test')).toBe(handler);
    });

    it('lookup throws UnknownJobTypeError for unregistered type', () => {
        const registry = new JobRegistry();
        expect(() => registry.lookup('missing')).toThrow(UnknownJobTypeError);
    });

    it('has returns true for registered type', () => {
        const registry = new JobRegistry();
        registry.register('x', async () => { });
        expect(registry.has('x')).toBe(true);
    });

    it('has returns false for unregistered type', () => {
        const registry = new JobRegistry();
        expect(registry.has('missing')).toBe(false);
    });

    it('unregister removes a handler', () => {
        const registry = new JobRegistry();
        registry.register('x', async () => { });
        expect(registry.has('x')).toBe(true);
        registry.unregister('x');
        expect(registry.has('x')).toBe(false);
    });

    it('registeredTypes returns all registered type names', () => {
        const registry = new JobRegistry();
        registry.register('a', async () => { });
        registry.register('b', async () => { });
        registry.register('c', async () => { });
        const types = registry.registeredTypes();
        expect(types.sort()).toEqual(['a', 'b', 'c']);
    });
});
