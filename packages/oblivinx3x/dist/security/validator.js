/**
 * @module security/validator
 *
 * Input sanitization and validation for documents.
 *
 * @packageDocumentation
 */
import { InputDepthError, InputSizeError } from '../errors/index.js';
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_SIZE = 16 * 1024 * 1024; // 16MB
/**
 * Validate document depth.
 */
export function validateDepth(value, maxDepth = DEFAULT_MAX_DEPTH, currentDepth = 0) {
    if (currentDepth > maxDepth) {
        throw new InputDepthError(maxDepth);
    }
    if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
            for (const item of value) {
                validateDepth(item, maxDepth, currentDepth + 1);
            }
        }
        else {
            for (const val of Object.values(value)) {
                validateDepth(val, maxDepth, currentDepth + 1);
            }
        }
    }
}
/**
 * Validate document size (approximate via JSON stringification).
 */
export function validateSize(doc, maxSize = DEFAULT_MAX_SIZE) {
    const size = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (size > maxSize) {
        throw new InputSizeError(maxSize, size);
    }
}
/**
 * Check if a document only contains allowed fields.
 */
export function validateAllowedFields(doc, allowed) {
    const violations = [];
    for (const key of Object.keys(doc)) {
        if (key === '_id')
            continue;
        if (!allowed.includes(key)) {
            violations.push(key);
        }
    }
    return violations;
}
/**
 * Sanitize a document based on validation config.
 * Returns the document if valid, throws if not.
 */
export function sanitizeInput(doc, config = {}, collection) {
    const maxDepth = config.maxDocumentDepth ?? DEFAULT_MAX_DEPTH;
    const maxSize = config.maxDocumentSize ?? DEFAULT_MAX_SIZE;
    // Check depth
    validateDepth(doc, maxDepth);
    // Check size
    validateSize(doc, maxSize);
    // Check field whitelist
    if (collection && config.allowedFields) {
        const allowed = config.allowedFields.get(collection);
        if (allowed) {
            const violations = validateAllowedFields(doc, allowed);
            if (violations.length > 0) {
                throw new Error(`Disallowed fields in collection '${collection}': ${violations.join(', ')}`);
            }
        }
    }
    return doc;
}
//# sourceMappingURL=validator.js.map