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

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

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

/** SQL comparison operator mapping to MQL */
const SQL_OP_MAP: Record<string, string> = {
  '=': '$eq',
  '!=': '$ne',
  '<>': '$ne',
  '>': '$gt',
  '>=': '$gte',
  '<': '$lt',
  '<=': '$lte',
  'LIKE': '$regex',
  'IN': '$in',
  'NOT IN': '$nin',
};

/** Token types for the lexer */
type TokenType =
  | 'KEYWORD' | 'IDENTIFIER' | 'NUMBER' | 'STRING'
  | 'OPERATOR' | 'COMMA' | 'STAR' | 'PARAM'
  | 'LPAREN' | 'RPAREN' | 'DOT' | 'EOF';

/** Lexer token */
interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly paramIndex?: number;
}

/** SQL keywords recognized by the parser */
const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT',
  'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'SKIP',
  'OFFSET', 'IN', 'LIKE', 'IS', 'NULL', 'BETWEEN',
  'EXISTS', 'TRUE', 'FALSE', 'AS', 'JOIN', 'ON',
  'GROUP', 'HAVING', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

// ═══════════════════════════════════════════════════════════════════════
// LEXER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Tokenize a SQL string with interpolated parameter placeholders.
 * @internal
 */
function tokenize(sqlParts: readonly string[], params: unknown[]): Token[] {
  const tokens: Token[] = [];

  for (let partIdx = 0; partIdx < sqlParts.length; partIdx++) {
    const part = sqlParts[partIdx] ?? '';
    let pos = 0;

    while (pos < part.length) {
      // Skip whitespace
      if (/\s/.test(part[pos] ?? '')) {
        pos++;
        continue;
      }

      const ch = part[pos] ?? '';

      // Single-char tokens
      if (ch === ',') { tokens.push({ type: 'COMMA', value: ',' }); pos++; continue; }
      if (ch === '*') { tokens.push({ type: 'STAR', value: '*' }); pos++; continue; }
      if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(' }); pos++; continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')' }); pos++; continue; }
      if (ch === '.') { tokens.push({ type: 'DOT', value: '.' }); pos++; continue; }

      // Multi-char operators: >=, <=, !=, <>
      const twoChar = part.slice(pos, pos + 2);
      if (twoChar === '>=' || twoChar === '<=' || twoChar === '!=' || twoChar === '<>') {
        tokens.push({ type: 'OPERATOR', value: twoChar });
        pos += 2;
        continue;
      }

      // Single-char operators: =, >, <
      if (ch === '=' || ch === '>' || ch === '<') {
        tokens.push({ type: 'OPERATOR', value: ch });
        pos++;
        continue;
      }

      // Quoted string: 'value'
      if (ch === "'") {
        let str = '';
        pos++; // skip opening quote
        while (pos < part.length && part[pos] !== "'") {
          if (part[pos] === '\\' && pos + 1 < part.length) {
            str += part[pos + 1];
            pos += 2;
          } else {
            str += part[pos];
            pos++;
          }
        }
        pos++; // skip closing quote
        tokens.push({ type: 'STRING', value: str });
        continue;
      }

      // Number
      if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(part[pos + 1] ?? ''))) {
        let num = '';
        if (ch === '-') { num += '-'; pos++; }
        while (pos < part.length && /[0-9.]/.test(part[pos] ?? '')) {
          num += part[pos];
          pos++;
        }
        tokens.push({ type: 'NUMBER', value: num });
        continue;
      }

      // Identifier or keyword
      if (/[a-zA-Z_]/.test(ch)) {
        let ident = '';
        while (pos < part.length && /[a-zA-Z0-9_]/.test(part[pos] ?? '')) {
          ident += part[pos];
          pos++;
        }
        const upper = ident.toUpperCase();
        if (SQL_KEYWORDS.has(upper)) {
          tokens.push({ type: 'KEYWORD', value: upper });
        } else {
          tokens.push({ type: 'IDENTIFIER', value: ident });
        }
        continue;
      }

      // Unknown character — skip
      pos++;
    }

    // After each SQL part (except the last), insert a PARAM token for the interpolated value
    if (partIdx < params.length) {
      tokens.push({ type: 'PARAM', value: '__param__', paramIndex: partIdx });
    }
  }

  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recursive descent parser for SQL-like syntax.
 * @internal
 */
class SqlParser {
  readonly #tokens: Token[];
  readonly #params: unknown[];
  #pos = 0;

  constructor(tokens: Token[], params: unknown[]) {
    this.#tokens = tokens;
    this.#params = params;
  }

  /** Current token */
  #current(): Token {
    return this.#tokens[this.#pos] ?? { type: 'EOF', value: '' };
  }

  /** Advance and return current token */
  #advance(): Token {
    const tok = this.#current();
    this.#pos++;
    return tok;
  }

  /** Expect a specific token type+value */
  #expect(type: TokenType, value?: string): Token {
    const tok = this.#current();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(
        `SQL Parse Error: Expected ${type}${value ? `('${value}')` : ''} ` +
        `but got ${tok.type}('${tok.value}') at position ${this.#pos}`,
      );
    }
    return this.#advance();
  }

  /** Check if current token matches */
  #peek(type: TokenType, value?: string): boolean {
    const tok = this.#current();
    return tok.type === type && (value === undefined || tok.value === value);
  }

  /** Resolve a token to a concrete value (handles PARAM, STRING, NUMBER) */
  #resolveValue(tok: Token): unknown {
    if (tok.type === 'PARAM') {
      return this.#params[tok.paramIndex ?? 0];
    }
    if (tok.type === 'NUMBER') {
      return tok.value.includes('.') ? parseFloat(tok.value) : parseInt(tok.value, 10);
    }
    if (tok.type === 'STRING') {
      return tok.value;
    }
    if (tok.type === 'KEYWORD') {
      if (tok.value === 'TRUE') return true;
      if (tok.value === 'FALSE') return false;
      if (tok.value === 'NULL') return null;
    }
    return tok.value;
  }

  // ─── PARSE ENTRY ─────────────────────────────────────────────────────

  parse(): CompiledSQL {
    return this.#parseSelect();
  }

  #parseSelect(): CompiledSQL {
    this.#expect('KEYWORD', 'SELECT');

    // Parse projection (field list or *)
    const projection = this.#parseSelectFields();

    // FROM clause
    this.#expect('KEYWORD', 'FROM');
    const collectionTok = this.#expect('IDENTIFIER');
    const collection = collectionTok.value;

    // Optional clauses
    let filter: FilterQuery = {};
    const options: FindOptions = {};

    if (projection) {
      options.projection = projection;
    }

    // WHERE
    if (this.#peek('KEYWORD', 'WHERE')) {
      this.#advance();
      filter = this.#parseWhereExpr();
    }

    // ORDER BY
    if (this.#peek('KEYWORD', 'ORDER')) {
      this.#advance();
      this.#expect('KEYWORD', 'BY');
      options.sort = this.#parseOrderBy();
    }

    // LIMIT
    if (this.#peek('KEYWORD', 'LIMIT')) {
      this.#advance();
      const limitTok = this.#advance();
      options.limit = this.#resolveValue(limitTok) as number;
    }

    // SKIP / OFFSET
    if (this.#peek('KEYWORD', 'SKIP') || this.#peek('KEYWORD', 'OFFSET')) {
      this.#advance();
      const skipTok = this.#advance();
      options.skip = this.#resolveValue(skipTok) as number;
    }

    const raw = this.#reconstructRaw();

    return { collection, filter, options, raw };
  }

  /** Parse SELECT field list → projection map */
  #parseSelectFields(): Record<string, 1> | null {
    if (this.#peek('STAR')) {
      this.#advance();
      return null; // No projection = all fields
    }

    const fields: Record<string, 1> = {};
    while (true) {
      const fieldTok = this.#expect('IDENTIFIER');
      let fieldName = fieldTok.value;

      // Support dot notation: field.subfield
      while (this.#peek('DOT')) {
        this.#advance();
        const sub = this.#expect('IDENTIFIER');
        fieldName += '.' + sub.value;
      }

      fields[fieldName] = 1;

      if (this.#peek('COMMA')) {
        this.#advance();
      } else {
        break;
      }
    }

    return fields;
  }

  /** Parse WHERE expression (handles AND/OR) */
  #parseWhereExpr(): FilterQuery {
    return this.#parseOrExpr();
  }

  /** Parse OR expressions */
  #parseOrExpr(): FilterQuery {
    const left = this.#parseAndExpr();

    if (this.#peek('KEYWORD', 'OR')) {
      const clauses: FilterQuery[] = [left];
      while (this.#peek('KEYWORD', 'OR')) {
        this.#advance();
        clauses.push(this.#parseAndExpr());
      }
      return { $or: clauses } as FilterQuery;
    }

    return left;
  }

  /** Parse AND expressions */
  #parseAndExpr(): FilterQuery {
    const left = this.#parseCondition();

    if (this.#peek('KEYWORD', 'AND')) {
      const clauses: FilterQuery[] = [left];
      while (this.#peek('KEYWORD', 'AND')) {
        this.#advance();
        clauses.push(this.#parseCondition());
      }
      return { $and: clauses } as FilterQuery;
    }

    return left;
  }

  /** Parse a single condition: field OP value */
  #parseCondition(): FilterQuery {
    // Handle NOT prefix
    if (this.#peek('KEYWORD', 'NOT')) {
      this.#advance();
      const inner = this.#parseCondition();
      return { $not: inner } as FilterQuery;
    }

    // Handle parenthesized expression
    if (this.#peek('LPAREN')) {
      this.#advance();
      const expr = this.#parseWhereExpr();
      this.#expect('RPAREN');
      return expr;
    }

    // field
    const fieldTok = this.#expect('IDENTIFIER');
    let fieldName = fieldTok.value;

    // Dot notation
    while (this.#peek('DOT')) {
      this.#advance();
      const sub = this.#expect('IDENTIFIER');
      fieldName += '.' + sub.value;
    }

    // IS NULL / IS NOT NULL
    if (this.#peek('KEYWORD', 'IS')) {
      this.#advance();
      if (this.#peek('KEYWORD', 'NOT')) {
        this.#advance();
        this.#expect('KEYWORD', 'NULL');
        return { [fieldName]: { $ne: null } } as FilterQuery;
      }
      this.#expect('KEYWORD', 'NULL');
      return { [fieldName]: { $eq: null } } as FilterQuery;
    }

    // BETWEEN min AND max
    if (this.#peek('KEYWORD', 'BETWEEN')) {
      this.#advance();
      const minTok = this.#advance();
      const minVal = this.#resolveValue(minTok);
      this.#expect('KEYWORD', 'AND');
      const maxTok = this.#advance();
      const maxVal = this.#resolveValue(maxTok);
      return { [fieldName]: { $gte: minVal, $lte: maxVal } } as FilterQuery;
    }

    // IN (val1, val2, ...)
    if (this.#peek('KEYWORD', 'IN') || this.#peek('KEYWORD', 'NOT')) {
      let notIn = false;
      if (this.#peek('KEYWORD', 'NOT')) {
        this.#advance();
        notIn = true;
      }

      if (this.#peek('KEYWORD', 'IN')) {
        this.#advance();
        const values = this.#parseValueList();
        const op = notIn ? '$nin' : '$in';
        return { [fieldName]: { [op]: values } } as FilterQuery;
      }
    }

    // LIKE pattern
    if (this.#peek('KEYWORD', 'LIKE')) {
      this.#advance();
      const patternTok = this.#advance();
      const pattern = String(this.#resolveValue(patternTok));
      // Convert SQL LIKE to regex: % → .*, _ → .
      const regex = pattern.replace(/%/g, '.*').replace(/_/g, '.');
      return { [fieldName]: { $regex: `^${regex}$` } } as FilterQuery;
    }

    // Standard comparison: field OP value
    const opTok = this.#expect('OPERATOR');
    const sqlOp = opTok.value;
    const mqlOp = SQL_OP_MAP[sqlOp];

    if (!mqlOp) {
      throw new Error(`SQL Parse Error: Unknown operator '${sqlOp}'`);
    }

    const valueTok = this.#advance();
    const value = this.#resolveValue(valueTok);

    return { [fieldName]: { [mqlOp]: value } } as FilterQuery;
  }

  /** Parse comma-separated value list in parentheses */
  #parseValueList(): unknown[] {
    this.#expect('LPAREN');
    const values: unknown[] = [];

    while (!this.#peek('RPAREN')) {
      const tok = this.#advance();
      values.push(this.#resolveValue(tok));

      if (this.#peek('COMMA')) {
        this.#advance();
      }
    }

    this.#expect('RPAREN');
    return values;
  }

  /** Parse ORDER BY clause → sort spec */
  #parseOrderBy(): Record<string, 1 | -1> {
    const sort: Record<string, 1 | -1> = {};

    while (true) {
      const fieldTok = this.#expect('IDENTIFIER');
      let fieldName = fieldTok.value;

      // Dot notation
      while (this.#peek('DOT')) {
        this.#advance();
        const sub = this.#expect('IDENTIFIER');
        fieldName += '.' + sub.value;
      }

      let dir: 1 | -1 = 1;
      if (this.#peek('KEYWORD', 'ASC')) {
        this.#advance();
        dir = 1;
      } else if (this.#peek('KEYWORD', 'DESC')) {
        this.#advance();
        dir = -1;
      }

      sort[fieldName] = dir;

      if (this.#peek('COMMA')) {
        this.#advance();
      } else {
        break;
      }
    }

    return sort;
  }

  /** Reconstruct raw SQL for debugging */
  #reconstructRaw(): string {
    return this.#tokens
      .filter(t => t.type !== 'EOF')
      .map(t => t.type === 'PARAM' ? `$${(t.paramIndex ?? 0) + 1}` : t.value)
      .join(' ');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

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
export function compileSql(
  sqlParts: TemplateStringsArray,
  ...params: unknown[]
): CompiledSQL {
  const tokens = tokenize(sqlParts, params);
  const parser = new SqlParser(tokens, params);
  return parser.parse();
}

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
export const sql = compileSql;
