/** Default clock backed by Date.now() */
export class SystemClock {
    now() {
        return Date.now();
    }
}
/** Singleton default clock instance */
export const systemClock = new SystemClock();
