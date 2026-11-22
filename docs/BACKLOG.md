# Backlog

Ordered. Work takes the first unchecked item, ships it with tests, and ticks it off in the same
commit. Items are sized to finish in one focused session; split an item if it is bigger than that.
Add newly discovered items where they belong, with a done-criterion.

Ground rules for every item: connectors stay read-only, secrets stay redacted at every boundary,
scope input stays validated, and nothing is described as verified against a live cluster unless a
test in CI does that.

## Foundation

- [x] **1. MCP server: `investigate` tool.** New package `@kube-triage/mcp-server` on the official
  MCP SDK over stdio, one read-only tool `investigate(namespace, service?, since?)` returning the
  same timeline as the CLI. Move `parseDuration` into core so the CLI and server share it.
  *Done when:* tests drive it through an in-memory MCP client with fake connectors (valid result,
  invalid scope gives a redacted tool error without calling a connector, a failing connector gives a
  partial timeline), and CI smoke-runs the built binary's `tools/list`.
- [x] **2. kind demo and end-to-end CI (written).** `demo/` has a kind config, a minimal Prometheus
  with kube-state-metrics, three deliberately broken apps (OOM, bad image, failing liveness probe),
  `demo/run.sh` that brings it up and runs the built CLI, `demo/assert-timeline.mjs` that checks the
  expected causes, static tests for all of it, and a `demo` job in CI. The job has never run: this
  was written without Docker or kind available, so none of the live behaviour is verified yet.
- [x] **2b. Make the `demo` CI job green.** The first live run found one bug (the API server sends
  unset fields as `null`, for example `eventTime`, which the Kubernetes schema rejected, so all
  Kubernetes evidence was lost); it is fixed with a test. The next run (CI #19, bf83996) passed:
  "Demo assertions passed (3 expected causes found)". README states the CLI was verified against a
  live kind cluster and Prometheus (not Loki, GitHub or pod logs).
- [ ] **2c. Demo stability and coverage.** Re-run the `demo` job several times to see whether it is
  flaky, and extend it to one more live shape (pod logs with `KUBE_TRIAGE_POD_LOGS=1`).
  *Done when:* at least five consecutive CI runs pass and a log-based cause is asserted live.
- [x] **3. Scenario test suite.** 20 scenarios through the real connectors and engine, each with the
  expected top likely cause; the suite reports a pass rate. Add a scenario whenever a diagnosis bug is found.
- [ ] **4. Dashboard end-to-end test in CI.** Playwright against the built dashboard, the API and
  the CI PostgreSQL: the list and a detail page render, an unreachable API shows the error page, a
  bad id gives 404, and no horizontal overflow at phone width. *Done when:* the job passes in CI.

## Evidence quality

- [x] **5. Pod logs with redaction.** (Opt-in, behind `KUBE_TRIAGE_POD_LOGS`.) Add recent log tail (including previous container) to the
  Kubernetes reader, redacted at the boundary, size-capped, as evidence. *Done when:* tests prove
  secrets in logs never reach the timeline and that huge logs are truncated.
- [ ] **6. Ownership chain.** Resolve Pod to ReplicaSet to Deployment so evidence is grouped by
  workload. (Rollout events are already tagged and correlated with the first problem.) *Done when:*
  a bad-rollout fixture groups the failing pods under the Deployment that rolled out.
- [ ] **7. Node, HPA and PVC evidence.** Node conditions (memory/disk pressure), HPA at max
  replicas, PVC pending. *Done when:* each has a fixture, a tag and a hypothesis rule with tests.
- [x] **8. Finer-grained MCP tools.** Separate tools for pod status, events and a single Prometheus
  check, with per-tool permissions in config. *Done when:* a tool disabled in config is not listed
  and cannot be called.
- [x] **9. Runbooks in the MCP and API results.** Return matching runbook ids and titles next to
  each likely cause, and show them in the dashboard. *Done when:* tests cover all three.

## Release and operations

- [ ] **10. Releases.** Changesets for versioning and an npm publish workflow with provenance
  (SHA-pinned actions, least-privilege token). *Done when:* a dry-run release workflow passes.
- [ ] **11. Self-observability.** OpenTelemetry traces around each connector call and the
  investigation, off by default. *Done when:* tests assert spans and that no secret appears in
  span attributes.
- [x] **12. API hardening.** Per-key rate limit, a cap on concurrent investigations, a retention
  policy for old incidents, and an endpoint that exports the latest audit hash so it can be anchored
  outside the database. *Done when:* each has an integration test against PostgreSQL.
- [ ] **13. Chart extras.** An optional NetworkPolicy limiting the API's egress to the database and
  the configured connector hosts, and a PodDisruptionBudget. *Done when:* `helm lint` and the static
  chart tests cover them.

## Done

- [x] **Loki connector.** Read-only LogQL range queries, errors grouped per pod and message shape,
  secrets redacted. Passes the shared connector contract with a fake HTTP server.
- [x] **Deploy correlation.** Read-only GitHub deployments connector, rollouts tagged from Kubernetes
  events, and a recent-change hypothesis that only blames a change preceding the first problem.
- [x] **Connector plugin interface.** `ConnectorPlugin` and `PluginRegistry` in core, built-in
  plugins for every connector, and `--plugin` in the CLI.
- [x] **Runbooks as Markdown.** Eleven runbooks, a loader with size and count limits, and a test that
  ties every likely cause to a runbook.
- [x] **API.** Fastify, Drizzle and PostgreSQL; incident store; append-only hash-chained audit log;
  API-key auth with roles. Tested against a real PostgreSQL.
- [x] **Web dashboard.** Next.js and Tailwind; incident list, likely causes and timeline; server-side
  key; security headers.
- [x] **Helm chart and images.** Read-only RBAC (get, list, watch; never Secrets), optional
  per-namespace Roles, secrets referenced by name, hardened containers. Static tests run in the test
  suite; `helm lint`, `helm template` and the image builds run in CI.

## Later

- [ ] **14. Optional LLM summary layer, off by default,** that only summarises collected evidence and
  cites evidence ids.
- [ ] **15. Actions with approval.** Any mutating action requires an explicit approval step and an
  audit-log entry first. Not to be started until a human has reviewed the MCP permissions model (item 8, done) and the API hardening (item 12, done).
