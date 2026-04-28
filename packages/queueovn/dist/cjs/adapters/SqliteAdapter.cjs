"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteAdapter = void 0;
const AdapterError_js_1 = require("../errors/AdapterError.cjs");
/**
 * SqliteAdapter — persistent adapter using better-sqlite3 with WAL mode.
 * better-sqlite3 is a peerDependency; we import it dynamically so users
 * who only use MemoryAdapter aren't forced to install it.
 *
 * @example
 * import { SqliteAdapter } from 'wa-job-queue';
 * const adapter = new SqliteAdapter({ path: './jobs.db' });
 * await adapter.initialize();
 */
class SqliteAdapter {
    dbPath;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = null;
    constructor({ path }) {
        this.dbPath = path;
    }
    /**
     * Initialize the database — call before using the adapter.
     * Creates the jobs table, enables WAL mode.
     */
    async initialize() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let BetterSqlite3;
        try {
            // Dynamic import so we don't crash if user hasn't installed it
            BetterSqlite3 = (await Promise.resolve(`${'better-sqlite3'}`).then(s => __importStar(require(s)))).default;
        }
        catch {
            throw new AdapterError_js_1.AdapterError('SqliteAdapter requires "better-sqlite3" to be installed. Run: npm install better-sqlite3');
        }
        this.db = new BetterSqlite3(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 5,
        run_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_runnable
        ON jobs (state, priority, run_at, created_at)
        WHERE state IN ('pending', 'retrying');
    `);
    }
    async push(job) {
        this.checkInit();
        this.db.prepare(`INSERT OR REPLACE INTO jobs (id, type, priority, run_at, state, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(job.id, job.type, job.priority, job.runAt, job.state, JSON.stringify(job), job.createdAt);
    }
    async pop() {
        this.checkInit();
        const now = Date.now();
        // Atomic pop: find the highest priority job, mark state as 'active' 
        // in the indexed column so other workers ignore it, and return its data.
        // The JobQueue will later update the full JSON data with the actively started job.
        const row = this.db.prepare(`UPDATE jobs 
             SET state = 'active'
             WHERE id = (
                 SELECT id FROM jobs
                 WHERE state IN ('pending', 'retrying') AND run_at <= ?
                 ORDER BY priority ASC, run_at ASC, created_at ASC
                 LIMIT 1
             )
             RETURNING data`).get(now);
        if (!row)
            return null;
        return JSON.parse(row.data);
    }
    async peek() {
        this.checkInit();
        const now = Date.now();
        const row = this.db.prepare(`SELECT data FROM jobs
       WHERE state IN ('pending', 'retrying') AND run_at <= ?
       ORDER BY priority ASC, run_at ASC, created_at ASC
       LIMIT 1`).get(now);
        if (!row)
            return null;
        return JSON.parse(row.data);
    }
    async get(id) {
        this.checkInit();
        const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id);
        return row ? JSON.parse(row.data) : null;
    }
    async update(job) {
        this.checkInit();
        this.db.prepare(`INSERT OR REPLACE INTO jobs (id, type, priority, run_at, state, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(job.id, job.type, job.priority, job.runAt, job.state, JSON.stringify(job), job.createdAt);
    }
    async remove(id) {
        this.checkInit();
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    }
    async size() {
        this.checkInit();
        const now = Date.now();
        const result = this.db.prepare(`SELECT COUNT(*) as cnt FROM jobs
       WHERE state IN ('pending', 'retrying') AND run_at <= ?`).get(now);
        return result?.cnt ?? 0;
    }
    async getAll() {
        this.checkInit();
        const rows = this.db.prepare('SELECT data FROM jobs').all();
        return rows.map((r) => JSON.parse(r.data));
    }
    async clear() {
        this.checkInit();
        this.db.prepare('DELETE FROM jobs').run();
    }
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    checkInit() {
        if (!this.db) {
            throw new AdapterError_js_1.AdapterError('SqliteAdapter not initialized. Call initialize() first.');
        }
    }
}
exports.SqliteAdapter = SqliteAdapter;
