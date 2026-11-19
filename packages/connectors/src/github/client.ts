import { z } from "zod";

const NAME = "[A-Za-z0-9_.-]+";
/** The only GitHub endpoints this client will ever call. All are read-only. */
const ALLOWED = [new RegExp(`^/repos/${NAME}/${NAME}/deployments$`), new RegExp(`^/repos/${NAME}/${NAME}/deployments/\\d+/statuses$`)];

export function assertReadOnlyGitHubPath(path: string): void {
  if (!ALLOWED.some((re) => re.test(path))) {
    throw new Error(`Refusing to call non-allowlisted GitHub path: ${path}`);
  }
}

const Deployment = z.object({
  id: z.number(),
  sha: z.string(),
  ref: z.string(),
  environment: z.string(),
  description: z.string().nullable().optional(),
  created_at: z.string(),
  creator: z.object({ login: z.string() }).nullable().optional(),
});
export type Deployment = z.infer<typeof Deployment>;

const Status = z.object({
  state: z.string(),
  description: z.string().nullable().optional(),
  created_at: z.string(),
});
export type DeploymentStatus = z.infer<typeof Status>;

export interface GitHubClientOptions {
  /** "owner/name" */
  repo: string;
  apiUrl?: string;
  /** A token with read access to deployments. Never logged. */
  token?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GitHubDeploymentsClient {
  private readonly owner: string;
  private readonly name: string;
  private readonly apiUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    const match = new RegExp(`^(${NAME})/(${NAME})$`).exec(options.repo);
    if (!match) throw new Error(`Invalid repository "${options.repo}": expected "owner/name".`);
    this.owner = match[1] as string;
    this.name = match[2] as string;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listDeployments(query: { environment?: string; perPage?: number }, signal?: AbortSignal): Promise<Deployment[]> {
    const params: Record<string, string> = { per_page: String(query.perPage ?? 30) };
    if (query.environment) params["environment"] = query.environment;
    const body = await this.get(`/repos/${this.owner}/${this.name}/deployments`, params, signal);
    return z.array(Deployment).parse(body);
  }

  /** The most recent status of a deployment, or undefined when it has none yet. */
  async latestStatus(deploymentId: number, signal?: AbortSignal): Promise<DeploymentStatus | undefined> {
    const body = await this.get(`/repos/${this.owner}/${this.name}/deployments/${deploymentId}/statuses`, { per_page: "1" }, signal);
    return z.array(Status).parse(body)[0];
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    assertReadOnlyGitHubPath(path);
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`GitHub ${path} returned HTTP ${res.status}`);
    return res.json();
  }
}
