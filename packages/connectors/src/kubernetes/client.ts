import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { KubeReader } from "./reader.js";

export interface KubeClientOptions {
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

  return {
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
