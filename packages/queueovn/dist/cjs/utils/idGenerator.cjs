"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateId = generateId;
const ulid_1 = require("ulid");
const ulid = (0, ulid_1.monotonicFactory)();
/**
 * Generate a unique, sortable, collision-resistant ID.
 * Uses ULID (Universally Unique Lexicographically Sortable Identifier).
 * @returns A 26-character uppercase string
 */
function generateId() {
    return ulid();
}
