/**
 * Mockable clock interface.
 * Inject a mock implementation in tests to control time deterministically.
 */
export interface IClock {
    now(): number;
}
/** Default clock backed by Date.now() */
export declare class SystemClock implements IClock {
    now(): number;
}
/** Singleton default clock instance */
export declare const systemClock: IClock;
