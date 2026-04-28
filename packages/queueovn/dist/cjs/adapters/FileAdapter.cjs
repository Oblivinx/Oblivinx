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
exports.FileAdapter = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const AdapterError_js_1 = require("../errors/AdapterError.cjs");
/**
 * FileAdapter — JSON flat-file adapter.
 * Great for dev, CLI tools, or small-scale deployments.
 * NOT suitable for high-concurrency production use.
 */
class FileAdapter {
    filePath;
    store = { jobs: {} };
    constructor({ filePath }) {
        this.filePath = filePath;
    }
    /**
     * Load the file store from disk (call on startup).
     */
    async initialize() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                this.store = JSON.parse(raw);
            }
            else {
                this.store = { jobs: {} };
                await this.flush();
            }
        }
        catch (err) {
            throw new AdapterError_js_1.AdapterError(`FileAdapter: failed to initialize from ${this.filePath}`, err);
        }
    }
    async push(job) {
        this.store.jobs[job.id] = job;
        await this.flush();
    }
    async pop() {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => {
            if (a.priority !== b.priority)
                return a.priority - b.priority;
            if (a.runAt !== b.runAt)
                return a.runAt - b.runAt;
            return a.createdAt - b.createdAt;
        });
        if (ready.length === 0)
            return null;
        const job = ready[0];
        delete this.store.jobs[job.id];
        await this.flush();
        return job;
    }
    async peek() {
        const now = Date.now();
        const ready = Object.values(this.store.jobs)
            .filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now)
            .sort((a, b) => a.priority - b.priority);
        return ready.length > 0 ? ready[0] : null;
    }
    async get(id) {
        return this.store.jobs[id] ?? null;
    }
    async update(job) {
        this.store.jobs[job.id] = job;
        await this.flush();
    }
    async remove(id) {
        delete this.store.jobs[id];
        await this.flush();
    }
    async size() {
        const now = Date.now();
        return Object.values(this.store.jobs).filter((j) => (j.state === 'pending' || j.state === 'retrying') && j.runAt <= now).length;
    }
    async getAll() {
        return Object.values(this.store.jobs);
    }
    async clear() {
        this.store = { jobs: {} };
        await this.flush();
    }
    async close() {
        await this.flush();
    }
    async flush() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf8');
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            throw new AdapterError_js_1.AdapterError(`FileAdapter: failed to flush to ${this.filePath}`, err);
        }
    }
}
exports.FileAdapter = FileAdapter;
