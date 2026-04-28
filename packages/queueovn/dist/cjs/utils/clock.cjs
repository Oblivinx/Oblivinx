"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemClock = exports.SystemClock = void 0;
/** Default clock backed by Date.now() */
class SystemClock {
    now() {
        return Date.now();
    }
}
exports.SystemClock = SystemClock;
/** Singleton default clock instance */
exports.systemClock = new SystemClock();
