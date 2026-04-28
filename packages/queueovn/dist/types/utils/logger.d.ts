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
export declare class ConsoleLogger implements ILogger {
    private readonly prefix;
    constructor(prefix?: string);
    private format;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** Null logger — discards all output. Useful for production opt-out. */
export declare class NullLogger implements ILogger {
    debug(_message: string, ..._args: unknown[]): void;
    info(_message: string, ..._args: unknown[]): void;
    warn(_message: string, ..._args: unknown[]): void;
    error(_message: string, ..._args: unknown[]): void;
}
/** Singleton default logger */
export declare const defaultLogger: ILogger;
