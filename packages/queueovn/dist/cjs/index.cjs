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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WORKER_CONFIG = exports.resolveConfig = exports.assert = exports.CircuitBreaker = exports.defaultLogger = exports.NullLogger = exports.ConsoleLogger = exports.systemClock = exports.SystemClock = exports.sleep = exports.generateId = exports.UnknownJobTypeError = exports.CyclicDependencyError = exports.DependencyError = exports.DiscardJobError = exports.RateLimitError = exports.AdapterError = exports.JobTimeoutError = exports.QueueError = exports.QueueEvent = exports.TypedEventEmitter = exports.Recovery = exports.Snapshot = exports.WALWriter = exports.Debounce = exports.JobTTL = exports.Throttle = exports.DeadLetterQueue = exports.Metrics = exports.Deduplicator = exports.RateLimiter = exports.FileAdapter = exports.OvnDbAdapter = exports.MemoryAdapter = exports.CustomRetry = exports.NoRetry = exports.LinearBackoff = exports.ExponentialBackoff = exports.JobBatch = exports.JobResultFactory = exports.JobState = exports.JobBuilder = exports.isJob = exports.updateJob = exports.createJob = exports.FlowController = exports.Scheduler = exports.JobRegistry = exports.PriorityHeap = exports.JobQueue = void 0;
exports.CommandCooldownPlugin = exports.MessageBufferPlugin = exports.WaRateLimiterPlugin = exports.AntiSpamPlugin = exports.CronScheduler = exports.WaBotContext = exports.SessionStore = exports.IpcPubSubBridge = exports.TypedPubSub = exports.PubSub = exports.SortedSet = exports.KvStore = exports.validateConfig = exports.DEFAULT_PERSISTENCE_CONFIG = void 0;
// ─── Core ─────────────────────────────────────────────────────────────────────
var JobQueue_js_1 = require("./core/JobQueue.cjs");
Object.defineProperty(exports, "JobQueue", { enumerable: true, get: function () { return JobQueue_js_1.JobQueue; } });
var PriorityHeap_js_1 = require("./core/PriorityHeap.cjs");
Object.defineProperty(exports, "PriorityHeap", { enumerable: true, get: function () { return PriorityHeap_js_1.PriorityHeap; } });
var JobRegistry_js_1 = require("./core/JobRegistry.cjs");
Object.defineProperty(exports, "JobRegistry", { enumerable: true, get: function () { return JobRegistry_js_1.JobRegistry; } });
var Scheduler_js_1 = require("./core/Scheduler.cjs");
Object.defineProperty(exports, "Scheduler", { enumerable: true, get: function () { return Scheduler_js_1.Scheduler; } });
var FlowController_js_1 = require("./core/FlowController.cjs");
Object.defineProperty(exports, "FlowController", { enumerable: true, get: function () { return FlowController_js_1.FlowController; } });
// ─── Job ──────────────────────────────────────────────────────────────────────
var Job_js_1 = require("./job/Job.cjs");
Object.defineProperty(exports, "createJob", { enumerable: true, get: function () { return Job_js_1.createJob; } });
Object.defineProperty(exports, "updateJob", { enumerable: true, get: function () { return Job_js_1.updateJob; } });
Object.defineProperty(exports, "isJob", { enumerable: true, get: function () { return Job_js_1.isJob; } });
var JobBuilder_js_1 = require("./job/JobBuilder.cjs");
Object.defineProperty(exports, "JobBuilder", { enumerable: true, get: function () { return JobBuilder_js_1.JobBuilder; } });
var JobState_js_1 = require("./job/JobState.cjs");
Object.defineProperty(exports, "JobState", { enumerable: true, get: function () { return JobState_js_1.JobState; } });
var JobResult_js_1 = require("./job/JobResult.cjs");
Object.defineProperty(exports, "JobResultFactory", { enumerable: true, get: function () { return JobResult_js_1.JobResultFactory; } });
var JobBatch_js_1 = require("./job/JobBatch.cjs");
Object.defineProperty(exports, "JobBatch", { enumerable: true, get: function () { return JobBatch_js_1.JobBatch; } });
// ─── Retry ────────────────────────────────────────────────────────────────────
var ExponentialBackoff_js_1 = require("./retry/ExponentialBackoff.cjs");
Object.defineProperty(exports, "ExponentialBackoff", { enumerable: true, get: function () { return ExponentialBackoff_js_1.ExponentialBackoff; } });
var LinearBackoff_js_1 = require("./retry/LinearBackoff.cjs");
Object.defineProperty(exports, "LinearBackoff", { enumerable: true, get: function () { return LinearBackoff_js_1.LinearBackoff; } });
var NoRetry_js_1 = require("./retry/NoRetry.cjs");
Object.defineProperty(exports, "NoRetry", { enumerable: true, get: function () { return NoRetry_js_1.NoRetry; } });
var CustomRetry_js_1 = require("./retry/CustomRetry.cjs");
Object.defineProperty(exports, "CustomRetry", { enumerable: true, get: function () { return CustomRetry_js_1.CustomRetry; } });
// ─── Adapters ─────────────────────────────────────────────────────────────────
var MemoryAdapter_js_1 = require("./adapters/MemoryAdapter.cjs");
Object.defineProperty(exports, "MemoryAdapter", { enumerable: true, get: function () { return MemoryAdapter_js_1.MemoryAdapter; } });
var OvnDbAdapter_js_1 = require("./adapters/OvnDbAdapter.cjs");
Object.defineProperty(exports, "OvnDbAdapter", { enumerable: true, get: function () { return OvnDbAdapter_js_1.OvnDbAdapter; } });
var FileAdapter_js_1 = require("./adapters/FileAdapter.cjs");
Object.defineProperty(exports, "FileAdapter", { enumerable: true, get: function () { return FileAdapter_js_1.FileAdapter; } });
// ─── Plugins ──────────────────────────────────────────────────────────────────
var RateLimiter_js_1 = require("./plugins/RateLimiter.cjs");
Object.defineProperty(exports, "RateLimiter", { enumerable: true, get: function () { return RateLimiter_js_1.RateLimiter; } });
var Deduplicator_js_1 = require("./plugins/Deduplicator.cjs");
Object.defineProperty(exports, "Deduplicator", { enumerable: true, get: function () { return Deduplicator_js_1.Deduplicator; } });
var Metrics_js_1 = require("./plugins/Metrics.cjs");
Object.defineProperty(exports, "Metrics", { enumerable: true, get: function () { return Metrics_js_1.Metrics; } });
var DeadLetterQueue_js_1 = require("./plugins/DeadLetterQueue.cjs");
Object.defineProperty(exports, "DeadLetterQueue", { enumerable: true, get: function () { return DeadLetterQueue_js_1.DeadLetterQueue; } });
var Throttle_js_1 = require("./plugins/Throttle.cjs");
Object.defineProperty(exports, "Throttle", { enumerable: true, get: function () { return Throttle_js_1.Throttle; } });
var JobTTL_js_1 = require("./plugins/JobTTL.cjs");
Object.defineProperty(exports, "JobTTL", { enumerable: true, get: function () { return JobTTL_js_1.JobTTL; } });
var Debounce_js_1 = require("./plugins/Debounce.cjs");
Object.defineProperty(exports, "Debounce", { enumerable: true, get: function () { return Debounce_js_1.Debounce; } });
__exportStar(require("./ipc/IpcRouter.cjs"), exports);
__exportStar(require("./ipc/IpcWorker.cjs"), exports);
__exportStar(require("./ipc/types.cjs"), exports);
// ─── Persistence ──────────────────────────────────────────────────────────────
var WALWriter_js_1 = require("./persistence/WALWriter.cjs");
Object.defineProperty(exports, "WALWriter", { enumerable: true, get: function () { return WALWriter_js_1.WALWriter; } });
var Snapshot_js_1 = require("./persistence/Snapshot.cjs");
Object.defineProperty(exports, "Snapshot", { enumerable: true, get: function () { return Snapshot_js_1.Snapshot; } });
var Recovery_js_1 = require("./persistence/Recovery.cjs");
Object.defineProperty(exports, "Recovery", { enumerable: true, get: function () { return Recovery_js_1.Recovery; } });
// ─── Events ───────────────────────────────────────────────────────────────────
var EventEmitter_js_1 = require("./events/EventEmitter.cjs");
Object.defineProperty(exports, "TypedEventEmitter", { enumerable: true, get: function () { return EventEmitter_js_1.TypedEventEmitter; } });
var QueueEvents_js_1 = require("./events/QueueEvents.cjs");
Object.defineProperty(exports, "QueueEvent", { enumerable: true, get: function () { return QueueEvents_js_1.QueueEvent; } });
// ─── Errors ───────────────────────────────────────────────────────────────────
var QueueError_js_1 = require("./errors/QueueError.cjs");
Object.defineProperty(exports, "QueueError", { enumerable: true, get: function () { return QueueError_js_1.QueueError; } });
var JobTimeoutError_js_1 = require("./errors/JobTimeoutError.cjs");
Object.defineProperty(exports, "JobTimeoutError", { enumerable: true, get: function () { return JobTimeoutError_js_1.JobTimeoutError; } });
var AdapterError_js_1 = require("./errors/AdapterError.cjs");
Object.defineProperty(exports, "AdapterError", { enumerable: true, get: function () { return AdapterError_js_1.AdapterError; } });
var RateLimitError_js_1 = require("./errors/RateLimitError.cjs");
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function () { return RateLimitError_js_1.RateLimitError; } });
var DiscardJobError_js_1 = require("./errors/DiscardJobError.cjs");
Object.defineProperty(exports, "DiscardJobError", { enumerable: true, get: function () { return DiscardJobError_js_1.DiscardJobError; } });
var DependencyError_js_1 = require("./errors/DependencyError.cjs");
Object.defineProperty(exports, "DependencyError", { enumerable: true, get: function () { return DependencyError_js_1.DependencyError; } });
Object.defineProperty(exports, "CyclicDependencyError", { enumerable: true, get: function () { return DependencyError_js_1.CyclicDependencyError; } });
Object.defineProperty(exports, "UnknownJobTypeError", { enumerable: true, get: function () { return DependencyError_js_1.UnknownJobTypeError; } });
// ─── Utils ────────────────────────────────────────────────────────────────────
var idGenerator_js_1 = require("./utils/idGenerator.cjs");
Object.defineProperty(exports, "generateId", { enumerable: true, get: function () { return idGenerator_js_1.generateId; } });
var sleep_js_1 = require("./utils/sleep.cjs");
Object.defineProperty(exports, "sleep", { enumerable: true, get: function () { return sleep_js_1.sleep; } });
var clock_js_1 = require("./utils/clock.cjs");
Object.defineProperty(exports, "SystemClock", { enumerable: true, get: function () { return clock_js_1.SystemClock; } });
Object.defineProperty(exports, "systemClock", { enumerable: true, get: function () { return clock_js_1.systemClock; } });
var logger_js_1 = require("./utils/logger.cjs");
Object.defineProperty(exports, "ConsoleLogger", { enumerable: true, get: function () { return logger_js_1.ConsoleLogger; } });
Object.defineProperty(exports, "NullLogger", { enumerable: true, get: function () { return logger_js_1.NullLogger; } });
Object.defineProperty(exports, "defaultLogger", { enumerable: true, get: function () { return logger_js_1.defaultLogger; } });
var circuitBreaker_js_1 = require("./utils/circuitBreaker.cjs");
Object.defineProperty(exports, "CircuitBreaker", { enumerable: true, get: function () { return circuitBreaker_js_1.CircuitBreaker; } });
var assert_js_1 = require("./utils/assert.cjs");
Object.defineProperty(exports, "assert", { enumerable: true, get: function () { return assert_js_1.assert; } });
// ─── Config ───────────────────────────────────────────────────────────────────
var QueueConfig_js_1 = require("./config/QueueConfig.cjs");
Object.defineProperty(exports, "resolveConfig", { enumerable: true, get: function () { return QueueConfig_js_1.resolveConfig; } });
Object.defineProperty(exports, "DEFAULT_WORKER_CONFIG", { enumerable: true, get: function () { return QueueConfig_js_1.DEFAULT_WORKER_CONFIG; } });
Object.defineProperty(exports, "DEFAULT_PERSISTENCE_CONFIG", { enumerable: true, get: function () { return QueueConfig_js_1.DEFAULT_PERSISTENCE_CONFIG; } });
var validateConfig_js_1 = require("./config/validateConfig.cjs");
Object.defineProperty(exports, "validateConfig", { enumerable: true, get: function () { return validateConfig_js_1.validateConfig; } });
// ─── Stores (Redis-compatible, no Redis required) ─────────────────────────────
var KvStore_js_1 = require("./stores/KvStore.cjs");
Object.defineProperty(exports, "KvStore", { enumerable: true, get: function () { return KvStore_js_1.KvStore; } });
var SortedSet_js_1 = require("./stores/SortedSet.cjs");
Object.defineProperty(exports, "SortedSet", { enumerable: true, get: function () { return SortedSet_js_1.SortedSet; } });
var PubSub_js_1 = require("./stores/PubSub.cjs");
Object.defineProperty(exports, "PubSub", { enumerable: true, get: function () { return PubSub_js_1.PubSub; } });
Object.defineProperty(exports, "TypedPubSub", { enumerable: true, get: function () { return PubSub_js_1.TypedPubSub; } });
Object.defineProperty(exports, "IpcPubSubBridge", { enumerable: true, get: function () { return PubSub_js_1.IpcPubSubBridge; } });
var SessionStore_js_1 = require("./stores/SessionStore.cjs");
Object.defineProperty(exports, "SessionStore", { enumerable: true, get: function () { return SessionStore_js_1.SessionStore; } });
var WaBotContext_js_1 = require("./stores/WaBotContext.cjs");
Object.defineProperty(exports, "WaBotContext", { enumerable: true, get: function () { return WaBotContext_js_1.WaBotContext; } });
// ─── Scheduler ────────────────────────────────────────────────────────────────
var CronScheduler_js_1 = require("./scheduler/CronScheduler.cjs");
Object.defineProperty(exports, "CronScheduler", { enumerable: true, get: function () { return CronScheduler_js_1.CronScheduler; } });
// ─── WhatsApp-specific plugins ────────────────────────────────────────────────
var WhatsAppPlugins_js_1 = require("./plugins/WhatsAppPlugins.cjs");
Object.defineProperty(exports, "AntiSpamPlugin", { enumerable: true, get: function () { return WhatsAppPlugins_js_1.AntiSpamPlugin; } });
Object.defineProperty(exports, "WaRateLimiterPlugin", { enumerable: true, get: function () { return WhatsAppPlugins_js_1.WaRateLimiterPlugin; } });
Object.defineProperty(exports, "MessageBufferPlugin", { enumerable: true, get: function () { return WhatsAppPlugins_js_1.MessageBufferPlugin; } });
Object.defineProperty(exports, "CommandCooldownPlugin", { enumerable: true, get: function () { return WhatsAppPlugins_js_1.CommandCooldownPlugin; } });
