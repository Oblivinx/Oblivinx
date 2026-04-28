"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogger = exports.NullLogger = exports.ConsoleLogger = void 0;
/** Default logger backed by console — zero external dependencies */
class ConsoleLogger {
    prefix;
    constructor(prefix = '[wa-job-queue]') {
        this.prefix = prefix;
    }
    format(level, message, args) {
        const payload = {
            timestamp: new Date().toISOString(),
            level,
            prefix: this.prefix,
            msg: message,
            ...(args.length > 0 ? { data: args } : {})
        };
        return JSON.stringify(payload);
    }
    debug(message, ...args) {
        console.debug(this.format('debug', message, args));
    }
    info(message, ...args) {
        console.info(this.format('info', message, args));
    }
    warn(message, ...args) {
        console.warn(this.format('warn', message, args));
    }
    error(message, ...args) {
        // If error object is passed, ensure its stack isn't lost in basic JSON.stringify
        const serializableArgs = args.map(arg => arg instanceof Error ? { message: arg.message, stack: arg.stack, name: arg.name } : arg);
        console.error(this.format('error', message, serializableArgs));
    }
}
exports.ConsoleLogger = ConsoleLogger;
/** Null logger — discards all output. Useful for production opt-out. */
class NullLogger {
    debug(_message, ..._args) { }
    info(_message, ..._args) { }
    warn(_message, ..._args) { }
    error(_message, ..._args) { }
}
exports.NullLogger = NullLogger;
/** Singleton default logger */
exports.defaultLogger = new ConsoleLogger();
