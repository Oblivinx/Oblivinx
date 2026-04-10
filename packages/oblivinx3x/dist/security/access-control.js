/**
 * @module security/access-control
 *
 * Collection-level permission management and field-level ACLs.
 *
 * @packageDocumentation
 */
/**
 * Check if an operation is allowed on a collection.
 */
export function checkPermission(permissions, collection, operation) {
    const collectionPerms = permissions.get(collection);
    if (!collectionPerms)
        return true; // No restrictions = allow all
    return collectionPerms.has(operation) || collectionPerms.has('admin');
}
/**
 * Check if a field is readable.
 */
export function isFieldReadable(acl, collection, field) {
    const fields = acl.get(collection);
    if (!fields)
        return true; // No ACL = allow
    const perms = fields.get(field);
    if (!perms)
        return true; // Field not in ACL = allow
    return perms.has('read');
}
/**
 * Check if a field is writable.
 */
export function isFieldWritable(acl, collection, field) {
    const fields = acl.get(collection);
    if (!fields)
        return true;
    const perms = fields.get(field);
    if (!perms)
        return true;
    return perms.has('write');
}
/**
 * Filter document fields based on ACL (for read operations).
 */
export function filterDocumentByACL(acl, collection, doc) {
    const fields = acl.get(collection);
    if (!fields)
        return doc; // No ACL = return as-is
    const filtered = {};
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
export function sanitizeDocumentByACL(acl, collection, doc) {
    const fields = acl.get(collection);
    if (!fields)
        return doc;
    const sanitized = {};
    for (const [key, value] of Object.entries(doc)) {
        if (isFieldWritable(acl, collection, key)) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
//# sourceMappingURL=access-control.js.map