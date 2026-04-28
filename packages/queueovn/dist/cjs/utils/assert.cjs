"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assert = assert;
const QueueError_js_1 = require("../errors/QueueError.cjs");
/**
 * Type-safe internal assertion.
 * Throws QueueError if condition is falsy.
 */
function assert(condition, message) {
    if (!condition) {
        throw new QueueError_js_1.QueueError(`Assertion failed: ${message}`);
    }
}
