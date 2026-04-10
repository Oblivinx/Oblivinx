/**
 * @module security
 *
 * Barrel export for security modules + SecurityContext factory.
 *
 * @packageDocumentation
 */

import {
  checkPermission,
  isFieldReadable,
  isFieldWritable,
  filterDocumentByACL,
  sanitizeDocumentByACL,
  type CollectionOperation,
  type CollectionPermissionMap,
  type FieldACL,
} from './access-control.js';

import { AuditLogger, InMemoryAuditLogBackend, type AuditEvent, type AuditLogBackend } from './audit-log.js';
import { sanitizeInput, validateDepth, validateSize, validateAllowedFields, type InputValidationConfig } from './validator.js';
import { RateLimiter } from './rate-limiter.js';

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
    writes?: number; // Max writes per second per collection
    reads?: number; // Max reads per second
  };
  /** Input validation settings */
  inputValidation?: {
    maxDocumentDepth?: number; // Default: 20
    maxDocumentSize?: number; // Default: 16MB
    allowedFields?: Map<string, string[]>; // Per-collection field whitelist
  };
}

/**
 * SecurityContext — central coordinator for all security concerns.
 */
export class SecurityContext {
  readonly permissions: CollectionPermissionMap;
  readonly fieldACLs: FieldACL;
  readonly auditLogger: AuditLogger;
  readonly rateLimiter: RateLimiter;
  readonly inputConfig: import('./validator.js').InputValidationConfig;

  constructor(options: SecurityOptions = {}) {
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
export function createSecurityContext(options: SecurityOptions = {}): SecurityContext {
  return new SecurityContext(options);
}

// Re-export all for external use
export {
  checkPermission,
  isFieldReadable,
  isFieldWritable,
  filterDocumentByACL,
  sanitizeDocumentByACL,
  AuditLogger,
  InMemoryAuditLogBackend,
  sanitizeInput,
  validateDepth,
  validateSize,
  validateAllowedFields,
  RateLimiter,
};
export type {
  CollectionOperation,
  CollectionPermissionMap,
  FieldACL,
  AuditEvent,
  AuditLogBackend,
  InputValidationConfig,
};
