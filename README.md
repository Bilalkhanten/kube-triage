# kube-triage

A **read-only** incident copilot for Kubernetes and Prometheus.

Point it at a namespace (and optionally a service). It collects evidence from the cluster,
Prometheus, Loki and your deployment history, orders it into a timeline, and lists likely
causes, each one citing the evidence it is based on and pointing at a runbook. It never changes
anything in your cluster.

Illustrative output:

```
$ kube-triage investigate -n shop -s checkout --prometheus-url http://prometheus:9090 \
    --runbooks ./runbooks --since 1h

Investigation of shop/checkout
2026-01-01T10:00:00Z to 2026-01-01T11:00:00Z (60m, times in UTC)

Timeline (3 items)
  [1] 10:15:00  INFO  github-deploys Deployed main (c0ffee1) to production by bilal: success
  [2] 10:20:00  CRIT  kubernetes Container app in checkout-abc was OOMKilled (exit code 137)
  [3] 10:20:00  WARN  prometheus Container restarts in the last 10m: checkout-abc crossed > 0 (peak 4)

Likely causes
  1. [high] Problems began shortly after a deployment
     The first problem appeared 5 minutes after the change. This is correlation, not proof.
     evidence: [1] [2]
     runbook: Problems began shortly after a change (recent-change.md)
  2. [medium] Container is running out of memory
     evidence: [2]
     runbook: Container is running out of memory (oom-killed.md)
```

## Status

| Part | What it is | State |
| --- | --- | --- |
| `@kube-triage/core` | Evidence, timeline, hypothesis rules, change correlation, runbooks, redaction, plugin registry | working |
| `@kube-triage/connectors` | Kubernetes (pods, events), Prometheus (range checks, alerts), Loki (error log patterns), GitHub deployments | working |
| `@kube-triage/cli` | `kube-triage investigate` | working |
| `@kube-triage/mcp-server` | MCP server over stdio with one read-only `investigate` tool | working |
| `@kube-triage/api` | Incident store on PostgreSQL, hash-chained audit log, API-key auth | working |
| `@kube-triage/web` | Read-only dashboard: incident list, causes and timeline | working |
| `runbooks/` | Eleven Markdown runbooks, one or more per likely cause | working |
| `deploy/` | Dockerfiles and a Helm chart with read-only RBAC | written, see below |
| `demo/` | kind cluster, Prometheus, kube-state-metrics and three broken apps, plus a CI job that investigates them | written, not yet run (see below) |

### What has and has not been verified

- **Unit and contract tests** (fixtures, fake HTTP servers) cover core, every connector, the CLI
  and the MCP server. Every connector must pass one shared contract.
- **A scenario suite** runs 20 realistic failures (OOM, bad image, unschedulable, failing probe, bad
  deploy, a deploy after or long before the failures, sources that are down, and more) through the real
  connectors and the real engine, and checks the top likely cause, what must and must not appear, and
  that every cause cites evidence that exists. It was checked to fail when rules are broken.
- **The API is tested against a real PostgreSQL 16**, in CI through a service container: migrations,
  the audit log's append-only triggers, concurrent writers, tamper detection, authentication and roles,
  rate limits, the concurrency cap, retention and audit anchoring.
- **The dashboard** was built and viewed in a real browser (light, dark and phone width) against the
  API running on real PostgreSQL, and its standalone build was run as a non-root user on a
  read-only filesystem. There is no automated browser test in CI yet.
- **The Helm chart** is covered by static tests (read-only RBAC, every referenced value exists, balanced
  template blocks, secure defaults). `helm lint`, `helm template` and the image builds run in CI; they
  have not been run on a developer machine.
- **Not verified against anything live:** a Kubernetes cluster, Prometheus, Loki or the GitHub API.
  The `demo/` end-to-end job (kind, Prometheus, three broken apps) is written and its manifests,
  assertions and script are covered by static tests, but the job itself has not run yet. Until it
  passes in CI, nothing here counts as verified against a live cluster.

## Quick start (CLI)

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js investigate -n <namespace> [-s <service>] [--prometheus-url <url>] [--loki-url <url>]
```

Options: `--since 30m|2h|1d`, `--kubeconfig`, `--context`, `--no-kubernetes`, `--runbooks <dir>`,
`--plugin <module>`, `--json`, `--no-color`.

## Configuration

Connectors are plugins, configured from the environment. A connector with no configuration is skipped.
Credentials are only ever read from the environment, never from arguments or tool input.

| Connector | Environment |
| --- | --- |
| `kubernetes` | `KUBECONFIG` or `KUBE_TRIAGE_KUBECONFIG`, `KUBE_TRIAGE_CONTEXT`, `KUBE_TRIAGE_NO_KUBERNETES=1` to turn it off, `KUBE_TRIAGE_POD_LOGS=1` to also read pod logs (see below) |
| `prometheus` | `PROMETHEUS_URL`, `PROMETHEUS_BEARER_TOKEN` |
| `loki` | `LOKI_URL`, `LOKI_BEARER_TOKEN`, `LOKI_TENANT_ID` |
| `github-deploys` | `GITHUB_DEPLOYS_REPO` (`owner/name`), `GITHUB_TOKEN`, `GITHUB_DEPLOYS_ENVIRONMENT`, `GITHUB_API_URL` |

`KUBE_TRIAGE_DISABLE=loki,github-deploys` skips connectors by name. `KUBE_TRIAGE_RUNBOOKS=<dir>` sets the runbook directory.

**Pod logs** are opt-in (`KUBE_TRIAGE_POD_LOGS=1`) because they need the extra `pods/log` permission and logs can be
sensitive. It reads the recent logs of crashing or restarted pods only (the previous instance first, at most five
pods, a tail limit and a 64 KB cap), keeps only error lines, groups repeats, redacts secrets, and reports a pod whose
logs it cannot read as an info item instead of failing. Loki and pod logs read the same lines, so confidence counts
them as one origin, not two witnesses.

## MCP server

```bash
pnpm build
PROMETHEUS_URL=http://prometheus:9090 node packages/mcp-server/dist/bin.js
```

Speaks MCP over stdio. Every tool only reads, and every tool is annotated read-only. Configuration comes only from
the environment above, never from tool arguments, and invalid input returns a redacted tool error before any
connector runs.

| Tool | What it does | Enabled |
| --- | --- | --- |
| `investigate` | Evidence from every configured source, as a timeline with likely causes (`since` default 30m, max 7d) | by default |
| `evidence_<source>` | The same, from one source only: `evidence_kubernetes`, `evidence_prometheus`, `evidence_loki`, `evidence_github_deploys` | opt-in |
| `list_runbooks`, `get_runbook` | List runbooks, or read one as Markdown (needs `KUBE_TRIAGE_RUNBOOKS`) | opt-in |

**Per-tool permissions.** Only `investigate` is enabled unless you say otherwise. `KUBE_TRIAGE_MCP_TOOLS` is a
comma-separated list of tools to enable, or `all`; `KUBE_TRIAGE_MCP_DISABLE` removes tools from that set. A tool that
is not enabled is not registered, so it is neither listed nor callable. A misspelt name is an error at start-up, not
something silently ignored. With `KUBE_TRIAGE_RUNBOOKS` set, results also list the matching runbooks.

## API and dashboard

The API stores every investigation as an incident and records who did what in an audit log.

```bash
docker compose up -d db                      # local PostgreSQL
pnpm build
node packages/api/dist/keygen.js dashboard viewer      # prints a key once, and the entry to store
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
export KUBE_TRIAGE_API_KEYS='[{"id":"dashboard","sha256":"<from keygen>","role":"viewer"}]'
export PROMETHEUS_URL=http://prometheus:9090
node packages/api/dist/server.js             # migrates on start, listens on 127.0.0.1:8080
```

| Endpoint | Role | |
| --- | --- | --- |
| `GET /healthz` | none | liveness |
| `GET /v1/incidents`, `GET /v1/incidents/:id` | viewer | list and read |
| `POST /v1/investigations` | investigator | run connectors and store the result |
| `PATCH /v1/incidents/:id` | investigator | mark open or resolved |
| `GET /v1/audit`, `GET /v1/audit/head`, `GET /v1/audit/verify` | admin | read the audit log, get its newest entry, verify its chain |

Roles are `viewer`, `investigator` and `admin`; each includes the one before it. Only SHA-256 hashes
of keys are stored, compared in constant time. The server refuses to start without keys.

| Setting | Default | |
| --- | --- | --- |
| `KUBE_TRIAGE_RATE_LIMIT` | 120 | requests per minute for each key |
| `KUBE_TRIAGE_ANON_RATE_LIMIT` | 30 | requests per minute for each address that has not authenticated |
| `KUBE_TRIAGE_MAX_CONCURRENT` | 4 | investigations at once; extra ones get `429 busy` |
| `KUBE_TRIAGE_RETENTION_DAYS` | off | purge incidents older than this, daily; never touches the audit log |
| `KUBE_TRIAGE_TRUST_PROXY` | off | trust `X-Forwarded-For`; only behind a proxy you control |
| `KUBE_TRIAGE_RUNBOOKS` | none | directory of runbooks to point at |

Limits are per replica (in memory). Because denied requests are audited, the anonymous limit also stops
someone filling the audit log with bad keys: only the first rejection in each window is written.

**Audit log.** Append-only: the database refuses `UPDATE`, `DELETE` and `TRUNCATE`. Each row's hash
covers the previous row's, so editing or removing rows in the middle is detectable with
`GET /v1/audit/verify`. Deleting the newest rows cannot be detected from the table alone, so
`GET /v1/audit/head` returns the newest entry: record it somewhere the database cannot reach (for example your
log pipeline) and pass it back as `/v1/audit/verify?anchorSeq=…&anchorHash=…` to prove nothing was cut off the end.
Investigations, status changes, audit reads and every denied request are recorded.

**Dashboard.** `packages/web` is a Next.js app that reads the API with a `viewer` key held on the
server (`KUBE_TRIAGE_API_URL`, `KUBE_TRIAGE_API_KEY`). It has no login of its own and no actions.
Put it behind an ingress or proxy that authenticates your users.

## Deploying

`deploy/docker` has the two Dockerfiles (build from the repository root). `deploy/helm/kube-triage`
installs the API and the dashboard:

```bash
helm install kube-triage deploy/helm/kube-triage \
  --set api.database.existingSecret=kube-triage-db \
  --set api.apiKeys.existingSecret=kube-triage-keys \
  --set web.apiKey.existingSecret=kube-triage-web-key \
  --set api.connectors.prometheusUrl=http://prometheus.monitoring:9090
```

The chart never creates Secrets and refuses to render until you name them. The API's service
account can only `get`, `list` and `watch` pods, events, deployments and replica sets, never Secrets.
Set `rbac.namespaces` to grant that in specific namespaces instead of cluster-wide. `rbac.podLogs=true` adds a single
`pods/log` `get` rule and turns on pod log reading; it is off by default. Containers run as
non-root with a read-only root filesystem and no capabilities. No Ingress is created.

## Runbooks

`runbooks/*.md` are Markdown with a small front matter block:

```
---
title: Container is running out of memory
hypotheses: oom-killed
---
```

They are guidance for people, never executed. They use read-only `kubectl` commands and leave any
change to the reader. A test requires every likely cause the engine can produce to have a runbook.
Point the CLI at a directory with `--runbooks` and each likely cause lists the runbooks that match.

## Writing a connector plugin

Implement `ConnectorPlugin` from `@kube-triage/core`: a name, a description, the environment
variables it reads, and `fromEnv(env)` returning a read-only `Connector` or `undefined` when it is
not configured. Load it with `--plugin ./my-plugin.mjs`; see
`packages/core/test/fixtures/example-plugin.mjs`. **A plugin runs with this process's privileges**, so
only load code you trust. Run any new connector through the shared contract in
`packages/connectors/test/contract.ts`.

## Safety model

- **Read-only by construction.** The Kubernetes connector depends on a `KubeReader` interface with
  only list and log-read methods. The Prometheus, Loki and GitHub clients send only `GET`, to allowlisted
  endpoints, and refuse anything else. The Helm chart grants only `get`, `list` and `watch` (and `get` on
  `pods/log` if you switch that on). MCP tools are all read-only and opt-in beyond `investigate`.
- **Secrets are redacted** at the connector boundary and again when the timeline is built: bearer
  tokens, JWTs, cloud keys, private keys, URL credentials, and values of keys such as `password` or `token`.
- **Input is validated.** Namespace and service must be valid Kubernetes names, which also keeps them
  safe to embed in PromQL and LogQL; label values are escaped.
- **Explainable.** Likely causes come from deterministic rules, and each lists the evidence it rests on.
  Confidence rises when independent sources agree. A change is only suspected if it precedes the first
  problem, and the output says plainly that this is correlation, not proof.
- **Accountable.** Access to stored incidents is authenticated, role-checked, rate-limited and audited, and the audit
  log can be anchored outside the database.
- **Partial results beat none.** If one source fails, you still get a timeline plus a note saying
  what could not be read.

## Development

```bash
docker compose up -d db
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
pnpm build       # tsc -b
pnpm typecheck   # sources and tests, plus the dashboard
pnpm test        # vitest, runs against source; API tests need DATABASE_URL and skip without it
pnpm build:web   # next build
```

## Roadmap

See [docs/BACKLOG.md](docs/BACKLOG.md). Next: getting the kind demo job green in CI
(the first run against a real cluster), a dashboard browser test in CI, node, HPA and PVC evidence, an optional
LLM summary layer that is off by default, and actions that need explicit approval and are audit-logged.

## License

MIT. See [LICENSE](LICENSE).
