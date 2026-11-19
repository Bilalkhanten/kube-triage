import { z } from "zod";

/** Accepts the Date objects the official client returns as well as raw JSON strings. */
const Time = z.union([z.date(), z.string()]).transform((v) => new Date(v));

const ContainerState = z.object({
  waiting: z.object({ reason: z.string().optional(), message: z.string().optional() }).optional(),
  terminated: z
    .object({
      reason: z.string().optional(),
      exitCode: z.number().optional(),
      message: z.string().optional(),
      finishedAt: Time.optional(),
    })
    .optional(),
});

export const PodSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  status: z
    .object({
      phase: z.string().optional(),
      startTime: Time.optional(),
      conditions: z
        .array(
          z.object({
            type: z.string(),
            status: z.string(),
            reason: z.string().optional(),
            message: z.string().optional(),
            lastTransitionTime: Time.optional(),
          }),
        )
        .optional(),
      containerStatuses: z
        .array(
          z.object({
            name: z.string(),
            restartCount: z.number().default(0),
            state: ContainerState.optional(),
            lastState: ContainerState.optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type Pod = z.infer<typeof PodSchema>;

export const EventSchema = z.object({
  metadata: z.object({ name: z.string().optional(), creationTimestamp: Time.optional() }).optional(),
  type: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  count: z.number().optional(),
  eventTime: Time.optional(),
  firstTimestamp: Time.optional(),
  lastTimestamp: Time.optional(),
  involvedObject: z.object({ kind: z.string().optional(), name: z.string().optional(), namespace: z.string().optional() }),
});
export type KubeEvent = z.infer<typeof EventSchema>;

/**
 * The connector's entire view of the cluster. It only lists; there is deliberately
 * no method that creates, patches or deletes anything.
 */
export interface KubeReader {
  listPods(namespace: string, signal?: AbortSignal): Promise<unknown[]>;
  listEvents(namespace: string, signal?: AbortSignal): Promise<unknown[]>;
}
