import type { IClock } from '../../src/utils/clock.js';

/**
 * Deterministic mock clock for scheduler and TTL tests.
 * Start at a fixed timestamp and advance manually.
 */
export class MockClock implements IClock {
    private _time: number;

    constructor(initialTime = 1_700_000_000_000) {
        this._time = initialTime;
    }

    now(): number {
        return this._time;
    }

    /** Advance clock by the given number of milliseconds */
    advance(ms: number): void {
        this._time += ms;
    }

    /** Set the clock to an exact timestamp */
    setTime(ts: number): void {
        this._time = ts;
    }
}
