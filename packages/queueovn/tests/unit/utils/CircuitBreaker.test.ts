import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/utils/CircuitBreaker.js';

describe('CircuitBreaker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('executes successfully when CLOSED', async () => {
        const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 1000 });
        const res = await cb.execute(async () => 'success');
        expect(res).toBe('success');
        expect(cb.isOpen).toBe(false);
        expect(cb.currentState).toBe('CLOSED');
    });

    it('opens after threshold failures', async () => {
        const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 1000 });

        await expect(cb.execute(async () => { throw new Error('fail 1'); })).rejects.toThrow('fail 1');
        expect(cb.isOpen).toBe(false);

        await expect(cb.execute(async () => { throw new Error('fail 2'); })).rejects.toThrow('fail 2');
        expect(cb.isOpen).toBe(true);
        expect(cb.currentState).toBe('OPEN');
    });

    it('fast-fails when OPEN', async () => {
        const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 1000 });
        await expect(cb.execute(async () => { throw new Error('fail 1'); })).rejects.toThrow('fail 1');

        let executed = false;
        await expect(cb.execute(async () => {
            executed = true;
            return 'will not reach';
        })).rejects.toThrow('Circuit is OPEN — fast failing');

        expect(executed).toBe(false);
    });

    it('allows a probe after recovery time (HALF_OPEN -> CLOSED)', async () => {
        const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 1000 });
        await expect(cb.execute(async () => { throw new Error('fail 1'); })).rejects.toThrow('fail 1');

        vi.advanceTimersByTime(1000);

        // Next attempt should be allowed as HALF_OPEN
        const res = await cb.execute(async () => 'probe success');
        expect(res).toBe('probe success');

        // Should transition back to CLOSED
        expect(cb.isOpen).toBe(false);
        expect(cb.currentState).toBe('CLOSED');
    });

    it('goes back to OPEN if probe fails (HALF_OPEN -> OPEN)', async () => {
        const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 1000 });
        await expect(cb.execute(async () => { throw new Error('fail 1'); })).rejects.toThrow('fail 1');

        vi.advanceTimersByTime(1000);

        // Next attempt allowed but fails
        await expect(cb.execute(async () => { throw new Error('fail 2'); })).rejects.toThrow('fail 2');

        // Should transition back to OPEN immediately
        expect(cb.isOpen).toBe(true);
        expect(cb.currentState).toBe('OPEN');

        // Resetting manually
        cb.reset();
        expect(cb.currentState).toBe('CLOSED');
    });
});
