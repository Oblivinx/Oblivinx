"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdapterError = void 0;
const QueueError_js_1 = require("./QueueError.cjs");
/**
 * Thrown when a storage adapter operation fails.
 */
class AdapterError extends QueueError_js_1.QueueError {
    constructor(message, cause) {
        super(message, cause);
        this.name = 'AdapterError';
    }
}
exports.AdapterError = AdapterError;
