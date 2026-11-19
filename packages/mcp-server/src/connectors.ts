import type { Connector } from "@kube-triage/core";
import { KubernetesConnector, PrometheusConnector, createKubeReader } from "@kube-triage/connectors";

/**
 * Connectors come from the environment, never from tool arguments, so a model cannot point the
 * server at another endpoint. Credentials are never accepted through arguments either.
 *
 *   PROMETHEUS_URL, PROMETHEUS_BEARER_TOKEN, KUBECONFIG (read by the client library),
 *   KUBE_TRIAGE_CONTEXT, KUBE_TRIAGE_NO_KUBERNETES=1
 */
export function buildConnectorsFromEnv(env: NodeJS.ProcessEnv): Connector[] {
  const connectors: Connector[] = [];
  if (!env["KUBE_TRIAGE_NO_KUBERNETES"]) {
    const context = env["KUBE_TRIAGE_CONTEXT"];
    connectors.push(new KubernetesConnector({ reader: createKubeReader(context ? { context } : {}) }));
  }
  const url = env["PROMETHEUS_URL"];
  if (url) {
    const token = env["PROMETHEUS_BEARER_TOKEN"];
    connectors.push(
      new PrometheusConnector({ baseUrl: url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }),
    );
  }
  return connectors;
}
