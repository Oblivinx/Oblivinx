/**
 * @module security
 *
 * Barrel export for security modules + SecurityContext factory.
 *
 * @packageDocumentation
 */
import { checkPermission, isFieldReadable, isFieldWritable, filterDocumentByACL, sanitizeDocumentByACL, } from './access-control.js';
import { AuditLogger, InMemoryAuditLogBackend } from './audit-log.js';
import { sanitizeInput, validateDepth, validateSize, validateAllowedFields } from './validator.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryValidator, defaultQueryValidator, QueryError } from './validation.js';
/**
 * SecurityContext — central coordinator for all security concerns.
 */
export class SecurityContext {
    permissions;
    fieldACLs;
    auditLogger;
    rateLimiter;
    inputConfig;
    constructor(options = {}) {
        // Permissions
        this.permissions = options.permissions ?? new Map();
        // Field ACLs (empty by default)
        this.fieldACLs = new Map();
        // Audit logger
        this.auditLogger = new AuditLogger({
            enabled: options.auditLog?.enabled ?? false,
            events: options.auditLog?.events,
        });
        // Rate limiter
        this.rateLimiter = new RateLimiter();
        if (options.rateLimit) {
            this.rateLimiter.configure({
                reads: options.rateLimit.reads,
                writes: options.rateLimit.writes,
            });
        }
        // Input validation config
        this.inputConfig = {
            maxDocumentDepth: options.inputValidation?.maxDocumentDepth,
            maxDocumentSize: options.inputValidation?.maxDocumentSize,
            allowedFields: options.inputValidation?.allowedFields,
        };
    }
}
/**
 * Create a SecurityContext from options.
 */
export function createSecurityContext(options = {}) {
    return new SecurityContext(options);
}
// Re-export all for external use
export { checkPermission, isFieldReadable, isFieldWritable, filterDocumentByACL, sanitizeDocumentByACL, AuditLogger, InMemoryAuditLogBackend, sanitizeInput, validateDepth, validateSize, validateAllowedFields, RateLimiter, QueryValidator, defaultQueryValidator, QueryError, };
//# sourceMappingURL=index.js.map