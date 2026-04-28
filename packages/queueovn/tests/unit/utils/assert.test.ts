import { describe, it, expect } from 'vitest';
import { assert } from '../../../src/utils/assert.js';

describe('assert', () => {
    it('does not throw when condition is true', () => {
        expect(() => assert(true, 'Should not throw')).not.toThrow();
        expect(() => assert(1 === 1, 'Math works')).not.toThrow();
        expect(() => assert('string', 'truthy')).not.toThrow();
    });

    it('throws when condition is false', () => {
        expect(() => assert(false, 'Should throw')).toThrow('Assertion failed: Should throw');
        expect(() => assert(null, 'null is falsy')).toThrow('Assertion failed: null is falsy');
        expect(() => assert(undefined, 'undefined is falsy')).toThrow('Assertion failed: undefined is falsy');
        expect(() => assert(0, 'zero is falsy')).toThrow('Assertion failed: zero is falsy');
    });

    it('uses default message if none provided', () => {
        expect(() => assert(false)).toThrow('Assertion failed: undefined');
    });
});
