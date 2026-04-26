/**
 * @module security
 *
 * Barrel export for security modules + SecurityContext factory.
 *
 * @packageDocumentation
 */
import { checkPermission, isFieldReadable, isFieldWritable, filterDocumentByACL, sanitizeDocumentByACL, type CollectionOperation, type CollectionPermissionMap, type FieldACL } from './access-control.js';
import { AuditLogger, InMemoryAuditLogBackend, type AuditEvent, type AuditLogBackend } from './audit-log.js';
import { sanitizeInput, validateDepth, validateSize, validateAllowedFields, type InputValidationConfig } from './validator.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryValidator, defaultQueryValidator, QueryError } from './validation.js';
/**
 * Security options for database initialization.
 */
export interface SecurityOptions {
    /** Per-collection read/write/delete ACL */
    permissions?: CollectionPermissionMap;
    /** Audit log configuration */
    auditLog?: {
        enabled: boolean;
        events?: ('insert' | 'update' | 'delete' | 'find')[];
    };
    /** Rate limiting configuration */
    rateLimit?: {
        writes?: number;
        reads?: number;
    };
    /** Input validation settings */
    inputValidation?: {
        maxDocumentDepth?: number;
        maxDocumentSize?: number;
        allowedFields?: Map<string, string[]>;
    };
}
/**
 * SecurityContext — central coordinator for all security concerns.
 */
export declare class SecurityContext {
    readonly permissions: CollectionPermissionMap;
    readonly fieldACLs: FieldACL;
    readonly auditLogger: AuditLogger;
    readonly rateLimiter: RateLimiter;
    readonly inputConfig: import('./validator.js').InputValidationConfig;
    constructor(options?: SecurityOptions);
}
/**
 * Create a SecurityContext from options.
 */
export declare function createSecurityContext(options?: SecurityOptions): SecurityContext;
export { checkPermission, isFieldReadable, isFieldWritable, filterDocumentByACL, sanitizeDocumentByACL, AuditLogger, InMemoryAuditLogBackend, sanitizeInput, validateDepth, validateSize, validateAllowedFields, RateLimiter, QueryValidator, defaultQueryValidator, QueryError, };
export type { CollectionOperation, CollectionPermissionMap, FieldACL, AuditEvent, AuditLogBackend, InputValidationConfig, };
//# sourceMappingURL=index.d.ts.map