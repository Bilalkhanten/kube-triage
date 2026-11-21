import { z } from "zod";

/** Accepts the Date objects the official client returns as well as raw JSON strings. */
const Time = z.union([z.date(), z.string()]).transform((v) => new Date(v));

/**
 * The API server serialises unset fields as `null` (for example `eventTime` on every legacy
 * event), so optional fields accept null and treat it as absent.
 */
const nullToUndefined = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
const optString = z.string().nullish().transform(nullToUndefined);
const optNumber = z.number().nullish().transform(nullToUndefined);
const optTime = Time.nullish().transform(nullToUndefined);

const ContainerState = z.object({
  waiting: z.object({ reason: optString, message: optString }).nullish().transform(nullToUndefined),
  terminated: z
    .object({
      reason: optString,
      exitCode: optNumber,
      message: optString,
      finishedAt: optTime,
    })
    .nullish().transform(nullToUndefined),
});

export const PodSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: optString,
    labels: z.record(z.string(), z.string()).nullish().transform(nullToUndefined),
  }),
  status: z
    .object({
      phase: optString,
      startTime: optTime,
      conditions: z
        .array(
          z.object({
            type: z.string(),
            status: z.string(),
            reason: optString,
            message: optString,
            lastTransitionTime: optTime,
          }),
        )
        .nullish().transform(nullToUndefined),
      containerStatuses: z
        .array(
          z.object({
            name: z.string(),
            restartCount: z.number().default(0),
            state: ContainerState.nullish().transform(nullToUndefined),
            lastState: ContainerState.nullish().transform(nullToUndefined),
          }),
        )
        .nullish().transform(nullToUndefined),
    })
    .nullish().transform(nullToUndefined),
});
export type Pod = z.infer<typeof PodSchema>;

export const EventSchema = z.object({
  metadata: z.object({ name: optString, creationTimestamp: optTime }).nullish().transform(nullToUndefined),
  type: optString,
  reason: optString,
  message: optString,
  count: optNumber,
  eventTime: optTime,
  firstTimestamp: optTime,
  lastTimestamp: optTime,
  involvedObject: z.object({ kind: optString, name: optString, namespace: optString }),
});
export type KubeEvent = z.infer<typeof EventSchema>;

/**
 * The connector's entire view of the cluster. It only lists; there is deliberately
 * no method that creates, patches or deletes anything.
 */
export interface PodLogRequest {
  namespace: string;
  pod: string;
  container: string;
  /** The previous (crashed) instance of the container instead of the current one. */
  previous: boolean;
  tailLines: number;
}

export interface KubeReader {
  listPods(namespace: string, signal?: AbortSignal): Promise<unknown[]>;
  listEvents(namespace: string, signal?: AbortSignal): Promise<unknown[]>;
  /**
   * Reads recent log lines, each prefixed with an RFC 3339 timestamp. Optional: it needs the extra
   * `pods/log` permission, so it is only wired up when pod logs are switched on.
   */
  readPodLog?(request: PodLogRequest, signal?: AbortSignal): Promise<string>;
}
