import { PluginRegistry, type ConnectorPlugin } from "@kube-triage/core";
import { GitHubDeploysConnector } from "./github/index.js";
import { createKubeReader, KubernetesConnector } from "./kubernetes/index.js";
import { LokiConnector } from "./loki/index.js";
import { PrometheusConnector } from "./prometheus/index.js";

function bearer(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Credentials come from the environment only, never from command-line arguments or tool input. */
export const kubernetesPlugin: ConnectorPlugin = {
  name: "kubernetes",
  description: "Pods and events from a Kubernetes cluster (read-only).",
  env: ["KUBE_TRIAGE_KUBECONFIG", "KUBECONFIG", "KUBE_TRIAGE_CONTEXT", "KUBE_TRIAGE_NO_KUBERNETES"],
  fromEnv(env) {
    if (env["KUBE_TRIAGE_NO_KUBERNETES"]) return undefined;
    const kubeconfigPath = env["KUBE_TRIAGE_KUBECONFIG"];
    const context = env["KUBE_TRIAGE_CONTEXT"];
    return new KubernetesConnector({
      reader: createKubeReader({
        ...(kubeconfigPath ? { kubeconfigPath } : {}),
        ...(context ? { context } : {}),
      }),
    });
  },
};

export const prometheusPlugin: ConnectorPlugin = {
  name: "prometheus",
  description: "Metric checks and firing alerts from Prometheus (read-only).",
  env: ["PROMETHEUS_URL", "PROMETHEUS_BEARER_TOKEN"],
  fromEnv(env) {
    const baseUrl = env["PROMETHEUS_URL"];
    if (!baseUrl) return undefined;
    return new PrometheusConnector({ baseUrl, headers: bearer(env["PROMETHEUS_BEARER_TOKEN"]) });
  },
};

export const lokiPlugin: ConnectorPlugin = {
  name: "loki",
  description: "Error log patterns from Loki (read-only).",
  env: ["LOKI_URL", "LOKI_BEARER_TOKEN", "LOKI_TENANT_ID"],
  fromEnv(env) {
    const baseUrl = env["LOKI_URL"];
    if (!baseUrl) return undefined;
    const tenantId = env["LOKI_TENANT_ID"];
    return new LokiConnector({
      baseUrl,
      headers: bearer(env["LOKI_BEARER_TOKEN"]),
      ...(tenantId ? { tenantId } : {}),
    });
  },
};

export const githubDeploysPlugin: ConnectorPlugin = {
  name: "github-deploys",
  description: "Recent GitHub deployments, to line problems up against changes (read-only).",
  env: ["GITHUB_DEPLOYS_REPO", "GITHUB_TOKEN", "GITHUB_DEPLOYS_ENVIRONMENT", "GITHUB_API_URL"],
  fromEnv(env) {
    const repo = env["GITHUB_DEPLOYS_REPO"];
    if (!repo) return undefined;
    const token = env["GITHUB_TOKEN"];
    const environment = env["GITHUB_DEPLOYS_ENVIRONMENT"];
    const apiUrl = env["GITHUB_API_URL"];
    return new GitHubDeploysConnector({
      repo,
      ...(token ? { token } : {}),
      ...(environment ? { environment } : {}),
      ...(apiUrl ? { apiUrl } : {}),
    });
  },
};

export const builtinPlugins: ConnectorPlugin[] = [kubernetesPlugin, prometheusPlugin, lokiPlugin, githubDeploysPlugin];

export function createDefaultRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of builtinPlugins) registry.register(plugin);
  return registry;
}
