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
exports.Snapshot = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Snapshot — periodic full state persistence.
 * Uses atomic rename (write to .tmp then rename) for crash-safety.
 */
class Snapshot {
    snapshotPath;
    adapter;
    timerId;
    lastSeq = -1;
    constructor(snapshotPath, adapter) {
        this.snapshotPath = snapshotPath;
        this.adapter = adapter;
    }
    /**
     * Write a snapshot immediately.
     * @param seq - The WAL sequence number at the time of snapshot
     */
    // fix: replaced fs.writeFileSync + fs.renameSync with async variants to avoid event loop blocking
    async write(seq) {
        const jobs = await this.adapter.getAll();
        const data = { seq, timestamp: Date.now(), jobs };
        const dir = path.dirname(this.snapshotPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.snapshotPath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tmp, this.snapshotPath);
        this.lastSeq = seq;
    }
    /**
     * Read the latest snapshot from disk.
     * Returns null if no snapshot exists.
     */
    read() {
        if (!fs.existsSync(this.snapshotPath))
            return null;
        try {
            const raw = fs.readFileSync(this.snapshotPath, 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /**
     * Start periodic snapshot schedule.
     * @param onError - Optional callback to surface snapshot errors (e.g. emit QueueEvent.ERROR)
     */
    // fix: onError callback added so snapshot failures are no longer silently swallowed
    schedule(intervalMs, getSeq, onSuccess, onError) {
        if (this.timerId !== undefined)
            return;
        this.timerId = setInterval(() => {
            this.write(getSeq())
                .then(() => onSuccess?.())
                .catch((err) => {
                // fix: surface error instead of catch(() => {}) silent swallow
                onError?.(err instanceof Error ? err : new Error(String(err)));
            });
        }, intervalMs);
    }
    /** Stop the periodic snapshot timer */
    stop() {
        if (this.timerId !== undefined) {
            clearInterval(this.timerId);
            this.timerId = undefined;
        }
    }
    get lastSnapshotSeq() {
        return this.lastSeq;
    }
}
exports.Snapshot = Snapshot;
