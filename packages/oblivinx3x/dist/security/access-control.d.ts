/**
 * @module security/access-control
 *
 * Collection-level permission management and field-level ACLs.
 *
 * @packageDocumentation
 */
/** Allowed operations on a collection */
export type CollectionOperation = 'read' | 'write' | 'delete' | 'admin';
/** Permission map: collection -> allowed operations */
export type CollectionPermissionMap = Map<string, Set<CollectionOperation>>;
/**
 * Check if an operation is allowed on a collection.
 */
export declare function checkPermission(permissions: CollectionPermissionMap, collection: string, operation: CollectionOperation): boolean;
/**
 * Field-level access control list.
 * Maps collection -> field -> allowed operations (read/write).
 */
export type FieldACL = Map<string, Map<string, Set<'read' | 'write'>>>;
/**
 * Check if a field is readable.
 */
export declare function isFieldReadable(acl: FieldACL, collection: string, field: string): boolean;
/**
 * Check if a field is writable.
 */
export declare function isFieldWritable(acl: FieldACL, collection: string, field: string): boolean;
/**
 * Filter document fields based on ACL (for read operations).
 */
export declare function filterDocumentByACL(acl: FieldACL, collection: string, doc: Record<string, unknown>): Record<string, unknown>;
/**
 * Sanitize document fields based on ACL (for write operations).
 * Removes fields that the caller is not allowed to write.
 */
export declare function sanitizeDocumentByACL(acl: FieldACL, collection: string, doc: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=access-control.d.ts.map