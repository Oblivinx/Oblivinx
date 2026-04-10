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
export function checkPermission(
  permissions: CollectionPermissionMap,
  collection: string,
  operation: CollectionOperation,
): boolean {
  const collectionPerms = permissions.get(collection);
  if (!collectionPerms) return true; // No restrictions = allow all
  return collectionPerms.has(operation) || collectionPerms.has('admin');
}

/**
 * Field-level access control list.
 * Maps collection -> field -> allowed operations (read/write).
 */
export type FieldACL = Map<string, Map<string, Set<'read' | 'write'>>>;

/**
 * Check if a field is readable.
 */
export function isFieldReadable(acl: FieldACL, collection: string, field: string): boolean {
  const fields = acl.get(collection);
  if (!fields) return true; // No ACL = allow
  const perms = fields.get(field);
  if (!perms) return true; // Field not in ACL = allow
  return perms.has('read');
}

/**
 * Check if a field is writable.
 */
export function isFieldWritable(acl: FieldACL, collection: string, field: string): boolean {
  const fields = acl.get(collection);
  if (!fields) return true;
  const perms = fields.get(field);
  if (!perms) return true;
  return perms.has('write');
}

/**
 * Filter document fields based on ACL (for read operations).
 */
export function filterDocumentByACL(
  acl: FieldACL,
  collection: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const fields = acl.get(collection);
  if (!fields) return doc; // No ACL = return as-is

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (isFieldReadable(acl, collection, key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Sanitize document fields based on ACL (for write operations).
 * Removes fields that the caller is not allowed to write.
 */
export function sanitizeDocumentByACL(
  acl: FieldACL,
  collection: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const fields = acl.get(collection);
  if (!fields) return doc;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (isFieldWritable(acl, collection, key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
