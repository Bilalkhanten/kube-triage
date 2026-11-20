import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { KubeReader, PodLogRequest } from "./reader.js";

/** Hard cap on bytes read per container log, whatever the tail length. */
const MAX_LOG_BYTES = 64 * 1024;

export interface KubeClientOptions {
  /** Also read pod logs. Needs the `pods/log` get permission. Off by default. */
  podLogs?: boolean;
  /** Path to a kubeconfig file. Defaults to the usual lookup (KUBECONFIG, ~/.kube/config, in-cluster). */
  kubeconfigPath?: string;
  context?: string;
}

/** Adapter over the official client. Exposes list calls only. */
export function createKubeReader(options: KubeClientOptions = {}): KubeReader {
  const kc = new KubeConfig();
  if (options.kubeconfigPath) kc.loadFromFile(options.kubeconfigPath);
  else kc.loadFromDefault();
  if (options.context) kc.setCurrentContext(options.context);
  const core = kc.makeApiClient(CoreV1Api);

  const readPodLog = async (r: PodLogRequest): Promise<string> =>
    core.readNamespacedPodLog({
      name: r.pod,
      namespace: r.namespace,
      container: r.container,
      previous: r.previous,
      tailLines: r.tailLines,
      limitBytes: MAX_LOG_BYTES,
      timestamps: true,
    });

  return {
    ...(options.podLogs ? { readPodLog } : {}),
    async listPods(namespace) {
      const res = await core.listNamespacedPod({ namespace });
      return res.items;
    },
    async listEvents(namespace) {
      const res = await core.listNamespacedEvent({ namespace });
      return res.items;
    },
  };
}
