import { describe, it, expect } from 'vitest';
import { ExponentialBackoff } from '../../../src/retry/ExponentialBackoff.js';
import { LinearBackoff } from '../../../src/retry/LinearBackoff.js';
import { NoRetry } from '../../../src/retry/NoRetry.js';
import { CustomRetry } from '../../../src/retry/CustomRetry.js';

const err = new Error('fail');

describe('Retry Policies', () => {
    describe('ExponentialBackoff', () => {
        it('allows retry when attempt < maxAttempts', () => {
            const policy = new ExponentialBackoff({ maxAttempts: 3 });
            expect(policy.shouldRetry(1, err)).toBe(true);
            expect(policy.shouldRetry(2, err)).toBe(true);
            expect(policy.shouldRetry(3, err)).toBe(false);
        });

        it('nextDelay returns value between 0 and cap', () => {
            const policy = new ExponentialBackoff({ maxAttempts: 5, base: 1000, cap: 10_000 });
            for (let i = 1; i <= 4; i++) {
                const delay = policy.nextDelay(i, err);
                expect(delay).toBeGreaterThanOrEqual(0);
                expect(delay).toBeLessThanOrEqual(10_000);
            }
        });
    });

    describe('LinearBackoff', () => {
        it('allows retry when attempt < maxAttempts', () => {
            const policy = new LinearBackoff({ maxAttempts: 2, interval: 500 });
            expect(policy.shouldRetry(1, err)).toBe(true);
            expect(policy.shouldRetry(2, err)).toBe(false);
        });

        it('nextDelay returns fixed interval', () => {
            const policy = new LinearBackoff({ maxAttempts: 5, interval: 2000 });
            expect(policy.nextDelay(1, err)).toBe(2000);
            expect(policy.nextDelay(3, err)).toBe(2000);
        });
    });

    describe('NoRetry', () => {
        it('is a singleton', () => {
            expect(NoRetry.getInstance()).toBe(NoRetry.getInstance());
        });

        it('never retries', () => {
            const policy = NoRetry.getInstance();
            expect(policy.shouldRetry(0, err)).toBe(false);
            expect(policy.shouldRetry(100, err)).toBe(false);
        });

        it('nextDelay returns 0', () => {
            expect(NoRetry.getInstance().nextDelay(1, err)).toBe(0);
        });
    });

    describe('CustomRetry', () => {
        it('uses predicate to determine retry', () => {
            const policy = new CustomRetry({
                predicate: (attempt) => attempt < 3,
                delay: 250,
            });
            expect(policy.shouldRetry(1, err)).toBe(true);
            expect(policy.shouldRetry(3, err)).toBe(false);
        });

        it('supports function delay', () => {
            const policy = new CustomRetry({
                predicate: () => true,
                delay: (attempt) => attempt * 100,
            });
            expect(policy.nextDelay(3, err)).toBe(300);
        });

        it('uses default delay of 1000 when not specified', () => {
            const policy = new CustomRetry({ predicate: () => true });
            expect(policy.nextDelay(1, err)).toBe(1000);
        });
    });
});
