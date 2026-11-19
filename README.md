# kube-triage

A **read-only** incident copilot for Kubernetes and Prometheus.

Point it at a namespace (and optionally a service). It collects evidence from the cluster and
Prometheus, orders it into a timeline, and lists likely causes, each one citing the evidence
it is based on. It never changes anything in your cluster.

Illustrative output:

```
$ kube-triage investigate -n shop -s checkout --prometheus-url http://prometheus:9090 --since 1h

Investigation of shop/checkout
2026-01-01T10:00:00Z to 2026-01-01T11:00:00Z (60m, times in UTC)

Timeline (3 items)
  [1] 10:20:00  CRIT  kubernetes Container app in checkout-abc was OOMKilled (exit code 137)
  [2] 10:20:00  WARN  prometheus Container restarts in the last 10m: checkout-abc crossed > 0 (peak 4)
  [3] 10:35:00  WARN  kubernetes Pod checkout-abc: BackOff - Back-off restarting failed container (x12)

Likely causes
  1. [high] Container is running out of memory
     evidence: [1]
     - Compare memory working set with the container's memory limit over the window.
```

## Status

Early. Week 1 of the plan is in place: the core model, the Kubernetes and Prometheus
connectors, and the CLI.

| Package | What it is | State |
| --- | --- | --- |
| `@kube-triage/core` | Evidence, timeline, hypothesis rules, redaction, investigation runner | working |
| `@kube-triage/connectors` | Kubernetes (pods, events) and Prometheus (range checks, firing alerts) | working |
| `@kube-triage/cli` | `kube-triage investigate` | working |
| `mcp-server` | Expose the connectors as MCP tools | planned |
| `api`, `web` | Incident store, audit log, dashboard | planned |
| Loki, deploy correlation, Helm chart, runbooks, plugin interface | | planned |

**Not yet verified against a live cluster.** The connectors are covered by unit and contract
tests using fixtures and a fake Prometheus, and the CLI was run against a fake Prometheus over
HTTP. A kind-based end-to-end test with a deliberately broken demo app is the next milestone.

## Quick start

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js investigate -n <namespace> [-s <service>] [--prometheus-url <url>]
```

Options: `--since 30m|2h|1d`, `--kubeconfig`, `--context`, `--no-kubernetes`, `--json`, `--no-color`.
`PROMETHEUS_URL` can replace `--prometheus-url`. For authenticated Prometheus set
`PROMETHEUS_BEARER_TOKEN` (it is read from the environment, never from arguments).

## Safety model

- **Read-only by construction.** The Kubernetes connector depends on a `KubeReader` interface
  that only has `list` methods. The Prometheus client only sends `GET` to three allowlisted
  query endpoints and refuses anything else.
- **Secrets are redacted** at the connector boundary and again when the timeline is built:
  bearer tokens, JWTs, cloud keys, private keys, URL credentials, and values of keys such as
  `password` or `token`.
- **Input is validated.** Namespace and service must be valid Kubernetes names, which also
  keeps them safe to embed in PromQL; label values are escaped.
- **Explainable.** Likely causes come from deterministic rules, and each lists the evidence ids
  it rests on. Confidence rises when independent sources agree.
- **Partial results beat none.** If one source fails, you still get a timeline plus a note
  saying what could not be read.

## Development

```bash
pnpm typecheck   # tsc over sources and tests
pnpm test        # vitest, runs against source, no build needed
pnpm build       # tsc -b
```

Every connector must pass the shared contract in `packages/connectors/test/contract.ts`:
valid evidence, attributed to the connector, unique deterministic ids, already redacted.

To add a connector, implement `Connector` from `@kube-triage/core` and run it through that
contract.

## Roadmap

1. MCP server exposing the connectors as read-only tools, and a kind-based demo with a broken app.
2. API with Postgres and an audit log, then a web dashboard with the timeline view.
3. Loki logs, deploy correlation, Helm chart, runbooks as Markdown, plugin interface.
4. Optional LLM summary layer, off by default, that only summarises evidence already collected.
5. Any action (such as restarting a pod) requires explicit approval and is audit-logged.
