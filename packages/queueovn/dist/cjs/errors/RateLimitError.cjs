"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitError = void 0;
const QueueError_js_1 = require("./QueueError.cjs");
/**
 * Thrown by RateLimiter and Throttle plugins when limits are exceeded.
 */
class RateLimitError extends QueueError_js_1.QueueError {
    constructor(message = 'Rate limit exceeded') {
        super(message);
        this.name = 'RateLimitError';
    }
}
exports.RateLimitError = RateLimitError;
