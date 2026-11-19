import type { Connector } from "@kube-triage/core";
import { createDefaultRegistry } from "@kube-triage/connectors";

/**
 * Connectors come from the environment, never from tool arguments, so a model cannot point the
 * server at another endpoint. Credentials are never accepted through arguments either.
 *
 *   PROMETHEUS_URL, PROMETHEUS_BEARER_TOKEN, LOKI_URL, LOKI_BEARER_TOKEN, LOKI_TENANT_ID,
 *   KUBE_TRIAGE_KUBECONFIG / KUBECONFIG, KUBE_TRIAGE_CONTEXT, KUBE_TRIAGE_NO_KUBERNETES=1,
 *   KUBE_TRIAGE_DISABLE=<comma separated connector names>
 */
export function buildConnectorsFromEnv(env: NodeJS.ProcessEnv): Connector[] {
  return createDefaultRegistry().connectorsFromEnv(env);
}
