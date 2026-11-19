import type { Connector } from "./connector.js";
import { redactSecrets } from "./redact.js";
import type { ConnectorError, EvidenceInput, InvestigationScope, Timeline } from "./schemas.js";
import { InvestigationScopeSchema } from "./schemas.js";
import { buildTimeline } from "./timeline.js";

export interface InvestigateOptions {
  signal?: AbortSignal;
  now?: Date;
}

/** Runs all connectors concurrently. A failing connector is reported, not fatal. */
export async function investigate(
  scopeInput: InvestigationScope,
  connectors: Connector[],
  options: InvestigateOptions = {},
): Promise<Timeline> {
  const scope = InvestigationScopeSchema.parse(scopeInput);
  const results = await Promise.allSettled(
    connectors.map((c) => c.collect(scope, { signal: options.signal })),
  );

  const evidence: EvidenceInput[] = [];
  const errors: ConnectorError[] = [];
  results.forEach((result, i) => {
    const name = connectors[i]?.name ?? "unknown";
    if (result.status === "fulfilled") {
      evidence.push(...result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ source: name, message: redactSecrets(message) });
    }
  });

  return buildTimeline({ scope, evidence, errors, now: options.now });
}
