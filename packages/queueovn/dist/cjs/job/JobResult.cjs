"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobResultFactory = void 0;
/**
 * Success/failure result wrapper.
 * Use `JobResult.success(value)` or `JobResult.failure(error)`.
 */
class JobResultFactory {
    /**
     * Create a successful result.
     */
    static success(value) {
        return { ok: true, value };
    }
    /**
     * Create a failure result.
     */
    static failure(error) {
        return { ok: false, error };
    }
}
exports.JobResultFactory = JobResultFactory;
