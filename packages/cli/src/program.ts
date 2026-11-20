import { Command, CommanderError, InvalidArgumentError } from "commander";
import { PluginRegistry, investigate, loadPluginModule, loadRunbooks, parseDuration, runbookRefs, type Connector, type Timeline } from "@kube-triage/core";
import { createDefaultRegistry } from "@kube-triage/connectors";
import { renderTimeline } from "./render.js";

export interface InvestigateOptions {
  namespace: string;
  service?: string;
  since: string;
  prometheusUrl?: string;
  lokiUrl?: string;
  runbooks?: string;
  plugin?: string[];
  kubeconfig?: string;
  context?: string;
  kubernetes: boolean;
  json?: boolean;
  color: boolean;
}

export interface ProgramDeps {
  buildConnectors(options: InvestigateOptions, env: NodeJS.ProcessEnv): Connector[] | Promise<Connector[]>;
  now(): Date;
  write(text: string): void;
  /** Where usage errors go. Defaults to stderr. */
  writeErr?(text: string): void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

/**
 * Flags override the environment. Credentials are only ever read from the environment,
 * never from argv where they show up in `ps`.
 */
export async function defaultBuildConnectors(
  options: InvestigateOptions,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry = createDefaultRegistry(),
): Promise<Connector[]> {
  for (const specifier of options.plugin ?? []) {
    registry.register(await loadPluginModule(specifier));
  }
  return registry.connectorsFromEnv({
    ...env,
    ...(options.prometheusUrl ? { PROMETHEUS_URL: options.prometheusUrl } : {}),
    ...(options.lokiUrl ? { LOKI_URL: options.lokiUrl } : {}),
    ...(options.kubeconfig ? { KUBE_TRIAGE_KUBECONFIG: options.kubeconfig } : {}),
    ...(options.context ? { KUBE_TRIAGE_CONTEXT: options.context } : {}),
    ...(options.kubernetes === false ? { KUBE_TRIAGE_NO_KUBERNETES: "1" } : {}),
  });
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
    .option("--loki-url <url>", "Loki base URL (default: $LOKI_URL)")
    .option(
      "--plugin <module>",
      "load a connector plugin module (runs its code with this process's privileges; repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--runbooks <dir>", "directory of Markdown runbooks to point at (default: $KUBE_TRIAGE_RUNBOOKS)")
    .option("--kubeconfig <path>", "path to a kubeconfig file")
    .option("--context <name>", "kubeconfig context to use")
    .option("--no-kubernetes", "skip the Kubernetes connector")
    .option("--json", "print the timeline as JSON")
    .option("--no-color", "disable colors")
    .action(async (raw: Omit<InvestigateOptions, "color"> & { color?: boolean }) => {
      const options: InvestigateOptions = {
        ...raw,
        prometheusUrl: raw.prometheusUrl ?? deps.env["PROMETHEUS_URL"],
        lokiUrl: raw.lokiUrl ?? deps.env["LOKI_URL"],
        runbooks: raw.runbooks ?? deps.env["KUBE_TRIAGE_RUNBOOKS"],
        color: (raw.color ?? true) && deps.isTTY && !deps.env["NO_COLOR"],
      };

      const connectors = await deps.buildConnectors(options, deps.env);
      if (connectors.length === 0) {
        throw new Error("Nothing to investigate: enable Kubernetes or pass --prometheus-url or --loki-url.");
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

      const runbooks = options.runbooks ? await loadRunbooks(options.runbooks) : [];
      if (options.json) {
        const matched = runbookRefs(timeline.hypotheses, runbooks);
        const out = options.runbooks ? { ...timeline, runbooks: matched } : timeline;
        deps.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        deps.write(renderTimeline(timeline, { color: options.color, runbooks }));
      }
    });

  return program;
}
