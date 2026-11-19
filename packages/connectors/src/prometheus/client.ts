import { z } from "zod";

/** The only Prometheus endpoints this client will ever call. All are read-only. */
const ALLOWED_PATHS = ["/api/v1/query", "/api/v1/query_range", "/api/v1/alerts"] as const;
type AllowedPath = (typeof ALLOWED_PATHS)[number];

export function assertReadOnlyPath(path: string): asserts path is AllowedPath {
  if (!(ALLOWED_PATHS as readonly string[]).includes(path)) {
    throw new Error(`Refusing to call non-allowlisted Prometheus path: ${path}`);
  }
}

const ErrorEnvelope = z.object({
  status: z.literal("error"),
  errorType: z.string().optional(),
  error: z.string().optional(),
});

const Sample = z.tuple([z.number(), z.string()]);

const Envelope = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("status", [z.object({ status: z.literal("success"), data }), ErrorEnvelope]);

const InstantResponse = Envelope(
  z.object({
    resultType: z.string(),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: Sample })),
  }),
);

const RangeResponse = Envelope(
  z.object({
    resultType: z.literal("matrix"),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()), values: z.array(Sample) })),
  }),
);

const AlertsResponse = Envelope(
  z.object({
    alerts: z.array(
      z.object({
        labels: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).default({}),
        state: z.string(),
        activeAt: z.string().optional(),
        value: z.string().optional(),
      }),
    ),
  }),
);

export type InstantSeries = { metric: Record<string, string>; value: [number, number] };
export type RangeSeries = { metric: Record<string, string>; values: [number, number][] };
export type PromAlert = {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt?: string | undefined;
  value?: string | undefined;
};

export interface PrometheusClientOptions {
  baseUrl: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: PrometheusClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = { accept: "application/json", ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async query(promql: string, time: Date, signal?: AbortSignal): Promise<InstantSeries[]> {
    const body = await this.get("/api/v1/query", { query: promql, time: toUnix(time) }, signal);
    const parsed = InstantResponse.parse(body);
    if (parsed.status === "error") throw promError(parsed);
    return parsed.data.result.map((r) => ({ metric: r.metric, value: [r.value[0], Number(r.value[1])] }));
  }

  async queryRange(
    promql: string,
    range: { from: Date; to: Date; stepSeconds: number },
    signal?: AbortSignal,
  ): Promise<RangeSeries[]> {
    const body = await this.get(
      "/api/v1/query_range",
      { query: promql, start: toUnix(range.from), end: toUnix(range.to), step: range.stepSeconds },
      signal,
    );
    const parsed = RangeResponse.parse(body);
    if (parsed.status === "error") throw promError(parsed);
    return parsed.data.result.map((r) => ({
      metric: r.metric,
      values: r.values.map(([t, v]) => [t, Number(v)] as [number, number]),
    }));
  }

  async alerts(signal?: AbortSignal): Promise<PromAlert[]> {
    const body = await this.get("/api/v1/alerts", {}, signal);
    const parsed = AlertsResponse.parse(body);
    if (parsed.status === "error") throw promError(parsed);
    return parsed.data.alerts;
  }

  private async get(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
    assertReadOnlyPath(path);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      throw new Error(`Prometheus ${path} returned HTTP ${res.status}`);
    }
    return res.json();
  }
}

function toUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function promError(e: { errorType?: string | undefined; error?: string | undefined }): Error {
  return new Error(`Prometheus error${e.errorType ? ` (${e.errorType})` : ""}: ${e.error ?? "unknown"}`);
}
