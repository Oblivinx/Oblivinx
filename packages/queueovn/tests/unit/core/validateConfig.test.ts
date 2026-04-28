import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../../src/config/validateConfig.js';
import { QueueError } from '../../../src/errors/QueueError.js';

describe('validateConfig', () => {
    it('passes on a minimal valid config', () => {
        expect(() => validateConfig({ name: 'test' })).not.toThrow();
    });

    it('throws when name is empty string', () => {
        expect(() => validateConfig({ name: '' })).toThrow(QueueError);
    });

    it('throws when name is whitespace', () => {
        expect(() => validateConfig({ name: '   ' })).toThrow(QueueError);
    });

    it('throws when name is not a string', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => validateConfig({ name: 42 as any })).toThrow(QueueError);
    });

    it('throws when maxQueueSize < 1', () => {
        expect(() => validateConfig({ name: 'q', maxQueueSize: 0 })).toThrow(QueueError);
    });

    it('passes when maxQueueSize >= 1', () => {
        expect(() => validateConfig({ name: 'q', maxQueueSize: 1 })).not.toThrow();
    });

    describe('workers', () => {
        it('throws when workers.min < 0', () => {
            expect(() => validateConfig({ name: 'q', workers: { min: -1 } })).toThrow(QueueError);
        });

        it('throws when workers.max < 1', () => {
            expect(() => validateConfig({ name: 'q', workers: { max: 0 } })).toThrow(QueueError);
        });

        it('throws when workers.min > workers.max', () => {
            expect(() => validateConfig({ name: 'q', workers: { min: 5, max: 2 } })).toThrow(QueueError);
        });

        it('throws when workers.monitorIntervalMs < 100', () => {
            expect(() => validateConfig({ name: 'q', workers: { monitorIntervalMs: 50 } })).toThrow(QueueError);
        });

        it('passes on valid worker config', () => {
            expect(() => validateConfig({
                name: 'q',
                workers: { min: 1, max: 4, monitorIntervalMs: 200 },
            })).not.toThrow();
        });
    });

    it('throws when defaultMaxAttempts < 1', () => {
        expect(() => validateConfig({ name: 'q', defaultMaxAttempts: 0 })).toThrow(QueueError);
    });

    it('throws when defaultMaxDuration < 100', () => {
        expect(() => validateConfig({ name: 'q', defaultMaxDuration: 50 })).toThrow(QueueError);
    });

    describe('persistence', () => {
        it('throws when persistence.walPath is not a string when enabled', () => {
            expect(() => validateConfig({
                name: 'q',
                persistence: { enabled: true, walPath: 42 as unknown as string },
            })).toThrow(QueueError);
        });

        it('throws when persistence.snapshotPath is not a string when enabled', () => {
            expect(() => validateConfig({
                name: 'q',
                persistence: { enabled: true, snapshotPath: 99 as unknown as string },
            })).toThrow(QueueError);
        });

        it('throws when persistence.snapshotIntervalMs < 1000', () => {
            expect(() => validateConfig({
                name: 'q',
                persistence: { snapshotIntervalMs: 500 },
            })).toThrow(QueueError);
        });

        it('passes when persistence is valid', () => {
            expect(() => validateConfig({
                name: 'q',
                persistence: {
                    enabled: true,
                    walPath: './test.wal',
                    snapshotPath: './snap.json',
                    snapshotIntervalMs: 5000,
                },
            })).not.toThrow();
        });

        it('passes when persistence.enabled is false (walPath type not checked)', () => {
            expect(() => validateConfig({
                name: 'q',
                persistence: { enabled: false, walPath: 42 as unknown as string },
            })).not.toThrow();
        });
    });

    describe('plugins', () => {
        it('throws when plugins is not an array', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(() => validateConfig({ name: 'q', plugins: 'wrong' as any })).toThrow(QueueError);
        });

        it('passes when plugins is an empty array', () => {
            expect(() => validateConfig({ name: 'q', plugins: [] })).not.toThrow();
        });
    });

    describe('defaultPriority', () => {
        it('throws when defaultPriority < 1', () => {
            expect(() => validateConfig({ name: 'q', defaultPriority: 0 })).toThrow(QueueError);
        });

        it('throws when defaultPriority > 10', () => {
            expect(() => validateConfig({ name: 'q', defaultPriority: 11 })).toThrow(QueueError);
        });

        it('passes when defaultPriority is between 1 and 10', () => {
            expect(() => validateConfig({ name: 'q', defaultPriority: 5 })).not.toThrow();
        });

        it('passes when defaultPriority is exactly 1', () => {
            expect(() => validateConfig({ name: 'q', defaultPriority: 1 })).not.toThrow();
        });

        it('passes when defaultPriority is exactly 10', () => {
            expect(() => validateConfig({ name: 'q', defaultPriority: 10 })).not.toThrow();
        });
    });
});
