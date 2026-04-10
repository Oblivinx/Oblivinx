/**
 * @module db/view-manager
 *
 * Manages view lifecycle: create, drop, list, refresh.
 * Delegated from Oblivinx3x database class.
 *
 * @packageDocumentation
 */
import type { ViewInfo, PipelineStage } from '../types/index.js';
/**
 * ViewManager handles all view-related operations.
 * Injected into Oblivinx3x via lazy getter.
 */
export declare class ViewManager {
    #private;
    /**
     * @param handle - Function that returns the native database handle
     */
    constructor(handle: () => number);
    /**
     * Create a logical view — stored query that always reads live data.
     */
    createView(name: string, definition: {
        source: string;
        pipeline: PipelineStage[];
        materializedOptions?: {
            refresh: 'on_write' | 'scheduled' | 'manual';
            schedule?: string;
            maxSize?: string;
        };
    }): Promise<void>;
    /**
     * Drop a view.
     */
    dropView(name: string): Promise<void>;
    /**
     * List all views defined in the database.
     */
    listViews(): Promise<ViewInfo[]>;
    /**
     * Manually refresh a materialized view.
     */
    refreshView(name: string): Promise<void>;
}
//# sourceMappingURL=view-manager.d.ts.map