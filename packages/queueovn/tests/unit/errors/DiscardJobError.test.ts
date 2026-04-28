import { describe, it, expect } from 'vitest';
import { DiscardJobError } from '../../../src/errors/DiscardJobError.js';

describe('DiscardJobError', () => {
    it('constructs with message and sets name/flag', () => {
        const err = new DiscardJobError('debounced');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(DiscardJobError);
        expect(err.name).toBe('DiscardJobError');
        expect(err.message).toBe('debounced');
        expect(err.isDiscardJobError).toBe(true);
    });

    it('DiscardJobError.is returns true for DiscardJobError instances', () => {
        const err = new DiscardJobError('test');
        expect(DiscardJobError.is(err)).toBe(true);
    });

    it('DiscardJobError.is returns false for regular errors', () => {
        expect(DiscardJobError.is(new Error('nope'))).toBe(false);
    });

    it('DiscardJobError.is returns false for non-errors', () => {
        expect(DiscardJobError.is('string')).toBe(false);
        expect(DiscardJobError.is(42)).toBe(false);
        expect(DiscardJobError.is(null)).toBe(false);
    });

    it('DiscardJobError.is returns true for duck-typed errors with isDiscardJobError flag', () => {
        const fakeErr = new Error('fake');
        (fakeErr as any).isDiscardJobError = true;
        expect(DiscardJobError.is(fakeErr)).toBe(true);
    });
});
