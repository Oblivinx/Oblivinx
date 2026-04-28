import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * Generate a unique, sortable, collision-resistant ID.
 * Uses ULID (Universally Unique Lexicographically Sortable Identifier).
 * @returns A 26-character uppercase string
 */
export function generateId(): string {
    return ulid();
}
