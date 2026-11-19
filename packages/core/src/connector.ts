import type { Evidence, InvestigationScope } from "./schemas.js";

export interface CollectOptions {
  signal?: AbortSignal;
}

/**
 * A connector is a read-only adapter to one data source.
 * It must never mutate the system it observes.
 */
export interface Connector {
  readonly name: string;
  collect(scope: InvestigationScope, options?: CollectOptions): Promise<Evidence[]>;
}
