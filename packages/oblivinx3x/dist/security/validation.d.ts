/**
 * @module security/validation
 *
 * MQL input validation and prototype pollution prevention.
 * All data entering the native layer must pass through this gate.
 *
 * @packageDocumentation
 */
import type { FilterQuery, UpdateQuery, Document } from '../types/index.js';
export declare class QueryError extends Error {
    readonly code: 'ERR_QUERY_INJECTION' | 'ERR_UNKNOWN_OPERATOR' | 'ERR_PROTOTYPE_POLLUTION';
    constructor(code: 'ERR_QUERY_INJECTION' | 'ERR_UNKNOWN_OPERATOR' | 'ERR_PROTOTYPE_POLLUTION', message: string);
}
/**
 * Validates and sanitizes MQL filter, update, and document inputs.
 *
 * All public methods:
 * 1. Deep-clone the input to strip prototype chain.
 * 2. Verify no forbidden keys (`__proto__`, `constructor`, `prototype`).
 * 3. Validate all operators against the allowlist.
 * 4. Reject `$where` unless `allowWhere` is enabled.
 * 5. Validate regex values for ReDoS risk.
 */
export declare class QueryValidator {
    #private;
    constructor(options?: {
        allowWhere?: boolean;
    });
    /**
     * Validate and sanitize a filter query.
     * Returns a safe clone on success; throws `QueryError` on violation.
     */
    validateFilter(filter: unknown): FilterQuery<Document>;
    /**
     * Validate and sanitize an update document.
     * Returns a safe clone on success; throws `QueryError` on violation.
     */
    validateUpdate(update: unknown): UpdateQuery<Document>;
    /**
     * Validate and sanitize a document before insert/replace.
     * Returns a safe clone on success; throws `QueryError` on violation.
     */
    validateDocument(doc: unknown): Document;
}
/** Singleton validator with default options (no $where, strict allowlist). */
export declare const defaultQueryValidator: QueryValidator;
//# sourceMappingURL=validation.d.ts.map