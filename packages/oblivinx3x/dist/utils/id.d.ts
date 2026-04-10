/**
 * @module utils/id
 *
 * ID generation utilities supporting multiple strategies.
 *
 * @packageDocumentation
 */
/** Supported ID generation strategies */
export type IdStrategy = 'uuid' | 'snowflake' | 'increment';
/** Snowflake ID configuration */
export interface SnowflakeConfig {
    workerId: number;
    datacenterId: number;
}
/**
 * Generate a new ID using the specified strategy.
 *
 * @param strategy - ID generation strategy
 * @param config - Optional configuration (required for snowflake)
 * @param collection - Collection name (used for increment strategy)
 * @returns Generated ID string
 */
export declare function generateId(strategy?: IdStrategy, config?: {
    snowflake?: SnowflakeConfig;
    collection?: string;
}): string;
/**
 * Reset the increment counter for a collection (useful for testing).
 */
export declare function resetIncrement(collection: string): void;
/**
 * Reset all increment counters (useful for testing).
 */
export declare function resetAllIncrements(): void;
//# sourceMappingURL=id.d.ts.map