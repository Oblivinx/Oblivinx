"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomRetry = void 0;
/**
 * CustomRetry — user-defined predicate-based retry policy.
 *
 * @example
 * new CustomRetry({
 *   predicate: (attempt, err) => attempt < 3 && err.message.includes('EAGAIN'),
 *   delay: (attempt) => attempt * 500,
 * })
 */
class CustomRetry {
    predicate;
    delayFn;
    constructor({ predicate, delay = 1_000 }) {
        this.predicate = predicate;
        this.delayFn = typeof delay === 'function' ? delay : () => delay;
    }
    shouldRetry(attempt, error) {
        return this.predicate(attempt, error);
    }
    nextDelay(attempt, error) {
        return this.delayFn(attempt, error);
    }
}
exports.CustomRetry = CustomRetry;
