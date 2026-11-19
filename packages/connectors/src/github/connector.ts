import { redactValue, type CollectOptions, type Connector, type Evidence, type InvestigationScope } from "@kube-triage/core";
import { GitHubDeploymentsClient, type GitHubClientOptions } from "./client.js";

export interface GitHubDeploysConnectorOptions extends GitHubClientOptions {
  /** Only deployments to this environment (for example "production"). */
  environment?: string;
  /** Most deployments whose status is fetched. */
  maxDeployments?: number;
}

const FAILED_STATES = new Set(["failure", "error"]);

/** Recent deployments as evidence, so problems can be lined up against changes. */
export class GitHubDeploysConnector implements Connector {
  readonly name = "github-deploys";
  private readonly client: GitHubDeploymentsClient;
  private readonly environment: string | undefined;
  private readonly maxDeployments: number;

  constructor(options: GitHubDeploysConnectorOptions) {
    this.client = new GitHubDeploymentsClient(options);
    this.environment = options.environment;
    this.maxDeployments = options.maxDeployments ?? 10;
  }

  async collect(scope: InvestigationScope, options: CollectOptions = {}): Promise<Evidence[]> {
    const from = Date.parse(scope.from);
    const to = Date.parse(scope.to);
    const deployments = (
      await this.client.listDeployments({ ...(this.environment ? { environment: this.environment } : {}) }, options.signal)
    )
      .filter((d) => {
        const t = Date.parse(d.created_at);
        return t >= from && t <= to;
      })
      .slice(0, this.maxDeployments);

    return Promise.all(
      deployments.map(async (d) => {
        const status = await this.client.latestStatus(d.id, options.signal);
        const state = status?.state ?? "pending";
        const failed = FAILED_STATES.has(state);
        return redactValue({
          id: `github-deploys:deployment:${d.id}`,
          source: this.name,
          kind: "github.deployment",
          observedAt: new Date(d.created_at).toISOString(),
          severity: failed ? ("warning" as const) : ("info" as const),
          summary: `Deployed ${d.ref} (${d.sha.slice(0, 7)}) to ${d.environment}${d.creator ? ` by ${d.creator.login}` : ""}: ${state}`,
          subject: { kind: "Deployment", name: `${d.environment}@${d.sha.slice(0, 7)}`, namespace: scope.namespace },
          tags: ["deploy"],
          data: { sha: d.sha, ref: d.ref, environment: d.environment, state, description: d.description ?? undefined },
        });
      }),
    );
  }
}
