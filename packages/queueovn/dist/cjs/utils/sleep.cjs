"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Uses setTimeout under the hood — compatible with vi.useFakeTimers().
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
