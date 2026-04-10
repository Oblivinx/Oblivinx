/**
 * @module security/validator
 *
 * Input sanitization and validation for documents.
 *
 * @packageDocumentation
 */
/** Validator configuration */
export interface InputValidationConfig {
    maxDocumentDepth?: number;
    maxDocumentSize?: number;
    allowedFields?: Map<string, string[]>;
}
/**
 * Validate document depth.
 */
export declare function validateDepth(value: unknown, maxDepth?: number, currentDepth?: number): void;
/**
 * Validate document size (approximate via JSON stringification).
 */
export declare function validateSize(doc: unknown, maxSize?: number): void;
/**
 * Check if a document only contains allowed fields.
 */
export declare function validateAllowedFields(doc: Record<string, unknown>, allowed: string[]): string[];
/**
 * Sanitize a document based on validation config.
 * Returns the document if valid, throws if not.
 */
export declare function sanitizeInput(doc: Record<string, unknown>, config?: InputValidationConfig, collection?: string): Record<string, unknown>;
//# sourceMappingURL=validator.d.ts.map