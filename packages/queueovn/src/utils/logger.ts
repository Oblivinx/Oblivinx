/**
 * Logger interface — inject a custom logger (pino, winston, etc.)
 * or leave it as the default ConsoleLogger.
 */
export interface ILogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/** Default logger backed by console — zero external dependencies */
export class ConsoleLogger implements ILogger {
    private readonly prefix: string;

    constructor(prefix = '[wa-job-queue]') {
        this.prefix = prefix;
    }

    private format(level: string, message: string, args: unknown[]): string {
        const payload = {
            timestamp: new Date().toISOString(),
            level,
            prefix: this.prefix,
            msg: message,
            ...(args.length > 0 ? { data: args } : {})
        };
        return JSON.stringify(payload);
    }

    debug(message: string, ...args: unknown[]): void {
        console.debug(this.format('debug', message, args));
    }

    info(message: string, ...args: unknown[]): void {
        console.info(this.format('info', message, args));
    }

    warn(message: string, ...args: unknown[]): void {
        console.warn(this.format('warn', message, args));
    }

    error(message: string, ...args: unknown[]): void {
        // If error object is passed, ensure its stack isn't lost in basic JSON.stringify
        const serializableArgs = args.map(arg =>
            arg instanceof Error ? { message: arg.message, stack: arg.stack, name: arg.name } : arg
        );
        console.error(this.format('error', message, serializableArgs));
    }
}

/** Null logger — discards all output. Useful for production opt-out. */
export class NullLogger implements ILogger {
    debug(_message: string, ..._args: unknown[]): void { /* noop */ }
    info(_message: string, ..._args: unknown[]): void { /* noop */ }
    warn(_message: string, ..._args: unknown[]): void { /* noop */ }
    error(_message: string, ..._args: unknown[]): void { /* noop */ }
}

/** Singleton default logger */
export const defaultLogger: ILogger = new ConsoleLogger();
