/**
 * Mockable clock interface.
 * Inject a mock implementation in tests to control time deterministically.
 */
export interface IClock {
    now(): number;
}

/** Default clock backed by Date.now() */
export class SystemClock implements IClock {
    now(): number {
        return Date.now();
    }
}

/** Singleton default clock instance */
export const systemClock: IClock = new SystemClock();
