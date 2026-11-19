import { z } from "zod";

/** The only Loki endpoint this client will ever call. It is read-only. */
const ALLOWED_PATHS = ["/loki/api/v1/query_range"] as const;
type AllowedPath = (typeof ALLOWED_PATHS)[number];

export function assertReadOnlyLokiPath(path: string): asserts path is AllowedPath {
  if (!(ALLOWED_PATHS as readonly string[]).includes(path)) {
    throw new Error(`Refusing to call non-allowlisted Loki path: ${path}`);
  }
}

const Response = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    data: z.object({
      resultType: z.string(),
      result: z.array(
        z.object({
          stream: z.record(z.string(), z.string()),
          values: z.array(z.tuple([z.string(), z.string()])),
        }),
      ),
    }),
  }),
  z.object({ status: z.literal("error"), error: z.string().optional() }),
]);

export interface LogLine {
  /** Milliseconds since the Unix epoch. */
  timeMs: number;
  line: string;
  labels: Record<string, string>;
}

export interface LokiClientOptions {
  baseUrl: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Sent as X-Scope-OrgID for multi-tenant Loki. */
  tenantId?: string;
  timeoutMs?: number;
}

export class LokiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: LokiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = {
      accept: "application/json",
      ...(options.tenantId ? { "x-scope-orgid": options.tenantId } : {}),
      ...options.headers,
    };
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async queryRange(
    logql: string,
    range: { from: Date; to: Date; limit: number },
    signal?: AbortSignal,
  ): Promise<LogLine[]> {
    const path = "/loki/api/v1/query_range";
    assertReadOnlyLokiPath(path);
    const url = new URL(this.baseUrl + path);
    url.searchParams.set("query", logql);
    url.searchParams.set("start", `${range.from.getTime()}000000`);
    url.searchParams.set("end", `${range.to.getTime()}000000`);
    url.searchParams.set("limit", String(range.limit));
    url.searchParams.set("direction", "forward");

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Loki ${path} returned HTTP ${res.status}`);

    const parsed = Response.parse(await res.json());
    if (parsed.status === "error") throw new Error(`Loki error: ${parsed.error ?? "unknown"}`);

    return parsed.data.result
      .flatMap((s) =>
        s.values.map(([ts, line]) => ({
          timeMs: Number(BigInt(ts) / 1_000_000n),
          line,
          labels: s.stream,
        })),
      )
      .sort((a, b) => a.timeMs - b.timeMs);
  }
}
