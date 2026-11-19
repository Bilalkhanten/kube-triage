import { Command, CommanderError, InvalidArgumentError } from "commander";
import { investigate, type Connector, type Timeline } from "@kube-triage/core";
import { KubernetesConnector, PrometheusConnector, createKubeReader } from "@kube-triage/connectors";
import { parseDuration } from "./duration.js";
import { renderTimeline } from "./render.js";

export interface InvestigateOptions {
  namespace: string;
  service?: string;
  since: string;
  prometheusUrl?: string;
  kubeconfig?: string;
  context?: string;
  kubernetes: boolean;
  json?: boolean;
  color: boolean;
}

export interface ProgramDeps {
  buildConnectors(options: InvestigateOptions, env: NodeJS.ProcessEnv): Connector[];
  now(): Date;
  write(text: string): void;
  /** Where usage errors go. Defaults to stderr. */
  writeErr?(text: string): void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

export function defaultBuildConnectors(options: InvestigateOptions, env: NodeJS.ProcessEnv): Connector[] {
  const connectors: Connector[] = [];
  if (options.kubernetes) {
    const reader = createKubeReader({
      ...(options.kubeconfig ? { kubeconfigPath: options.kubeconfig } : {}),
      ...(options.context ? { context: options.context } : {}),
    });
    connectors.push(new KubernetesConnector({ reader }));
  }
  if (options.prometheusUrl) {
    // Credentials come from the environment, never from argv where they show up in `ps`.
    const token = env["PROMETHEUS_BEARER_TOKEN"];
    connectors.push(
      new PrometheusConnector({
        baseUrl: options.prometheusUrl,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      }),
    );
  }
  return connectors;
}

function duration(value: string): string {
  try {
    parseDuration(value);
    return value;
  } catch (e) {
    throw new InvalidArgumentError((e as Error).message);
  }
}

export { CommanderError };

export function createProgram(deps: ProgramDeps): Command {
  const program = new Command("kube-triage")
    .description("Read-only incident copilot for Kubernetes and Prometheus")
    .showHelpAfterError()
    // Set before subcommands are created so they inherit it. Errors throw instead of exiting.
    .exitOverride()
    .configureOutput({
      writeOut: deps.write,
      writeErr: deps.writeErr ?? ((t) => process.stderr.write(t)),
    });

  program
    .command("investigate")
    .description("Collect evidence for a namespace or service and print a timeline with likely causes")
    .requiredOption("-n, --namespace <name>", "Kubernetes namespace to investigate")
    .option("-s, --service <name>", "limit to one service (matches pod name prefix or the app label)")
    .option("--since <duration>", "how far back to look (e.g. 30m, 2h, 1d)", duration, "30m")
    .option("--prometheus-url <url>", "Prometheus base URL (default: $PROMETHEUS_URL)")
    .option("--kubeconfig <path>", "path to a kubeconfig file")
    .option("--context <name>", "kubeconfig context to use")
    .option("--no-kubernetes", "skip the Kubernetes connector")
    .option("--json", "print the timeline as JSON")
    .option("--no-color", "disable colors")
    .action(async (raw: Omit<InvestigateOptions, "color"> & { color?: boolean }) => {
      const options: InvestigateOptions = {
        ...raw,
        prometheusUrl: raw.prometheusUrl ?? deps.env["PROMETHEUS_URL"],
        color: (raw.color ?? true) && deps.isTTY && !deps.env["NO_COLOR"],
      };

      const connectors = deps.buildConnectors(options, deps.env);
      if (connectors.length === 0) {
        throw new Error("Nothing to investigate: enable Kubernetes or pass --prometheus-url.");
      }

      const now = deps.now();
      const timeline: Timeline = await investigate(
        {
          namespace: options.namespace,
          ...(options.service ? { service: options.service } : {}),
          from: new Date(now.getTime() - parseDuration(options.since)).toISOString(),
          to: now.toISOString(),
        },
        connectors,
        { now },
      );

      deps.write(options.json ? JSON.stringify(timeline, null, 2) + "\n" : renderTimeline(timeline, { color: options.color }));
    });

  return program;
}
