/**
 * @file SqlLikeQuery.ts
 * @module oblivinx3x/query
 * @description
 *   Tagged template literal SQL parser for Oblivinx3x.
 *   Provides a SQL-like syntax that compiles to MQL filter/pipeline objects.
 *
 *   Supports:
 *   - SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ... SKIP ...
 *   - Parameterized values via template interpolation (safe from injection)
 *   - Translates to MQL FilterQuery + FindOptions
 *
 *   This is a recursive-descent parser optimized for the subset of SQL
 *   that maps cleanly to document database operations.
 *
 * @architecture
 *   Pattern: Interpreter — Template Literal → Token[] → AST → MQL
 *   Ref: Section 4.5 (SQL-Like Interface)
 *
 * @example
 * ```typescript
 * import { sql, compileSql } from 'oblivinx3x';
 *
 * const age = 18;
 * const city = 'Jakarta';
 * const query = sql`SELECT name, email FROM users WHERE age >= ${age} AND city = ${city} ORDER BY name ASC LIMIT 20`;
 *
 * // query.collection === 'users'
 * // query.filter === { $and: [{ age: { $gte: 18 } }, { city: { $eq: 'Jakarta' } }] }
 * // query.options === { projection: { name: 1, email: 1 }, sort: { name: 1 }, limit: 20 }
 * ```
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */
import type { Document, FilterQuery, FindOptions } from '../types/index.js';
/** Compiled SQL result — ready for Collection execution */
export interface CompiledSQL<T extends Document = Document> {
    /** Target collection name (FROM clause) */
    readonly collection: string;
    /** MQL filter from WHERE clause */
    readonly filter: FilterQuery<T>;
    /** FindOptions from SELECT, ORDER BY, LIMIT, SKIP */
    readonly options: FindOptions<T>;
    /** Original SQL string (for debugging) */
    readonly raw: string;
}
/**
 * Compile a SQL-like query string to MQL filter + options.
 *
 * @param sqlParts - Template literal string parts
 * @param params - Interpolated parameter values
 * @returns CompiledSQL object with collection, filter, options
 *
 * @example
 * ```typescript
 * const result = compileSql`SELECT name, age FROM users WHERE age >= ${18} ORDER BY name ASC LIMIT 10`;
 * // result.collection = 'users'
 * // result.filter = { age: { $gte: 18 } }
 * // result.options = { projection: { name: 1, age: 1 }, sort: { name: 1 }, limit: 10 }
 * ```
 */
export declare function compileSql(sqlParts: TemplateStringsArray, ...params: unknown[]): CompiledSQL;
/**
 * Tagged template literal for SQL-like queries.
 * Alias for `compileSql`.
 *
 * @example
 * ```typescript
 * const minAge = 18;
 * const { collection, filter, options } = sql`
 *   SELECT name, email
 *   FROM users
 *   WHERE age >= ${minAge} AND active = ${true}
 *   ORDER BY name ASC
 *   LIMIT 50
 * `;
 * ```
 */
export declare const sql: typeof compileSql;
//# sourceMappingURL=SqlLikeQuery.d.ts.map