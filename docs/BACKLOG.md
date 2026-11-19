# Backlog

Ordered. Work takes the first unchecked item, ships it with tests, and ticks it off in the same
commit. Items are sized to finish in one focused session; split an item if it is bigger than that.
Add newly discovered items where they belong, with a done-criterion.

Ground rules for every item: connectors stay read-only, secrets stay redacted at every boundary,
scope input stays validated, and nothing is described as verified against a live cluster unless a
test in CI does that.

## Foundation

- [ ] **1. MCP server: `investigate` tool.** New package `@kube-triage/mcp-server` on the official
  MCP SDK over stdio, one read-only tool `investigate(namespace, service?, since?)` returning the
  same timeline as the CLI. Move `parseDuration` into core so the CLI and server share it.
  *Done when:* tests drive it through an in-memory MCP client with fake connectors (valid result,
  invalid scope gives a redacted tool error without calling a connector, a failing connector gives a
  partial timeline), and CI smoke-runs the built binary's `tools/list`.
- [ ] **2. kind demo and end-to-end CI.** `demo/` with a kind cluster config, Prometheus with
  kube-state-metrics, and a deliberately broken app (OOM, bad image, failing probe), plus a script
  that brings it up. *Done when:* a CI job creates the cluster, runs `kube-triage investigate`, and
  asserts the expected evidence and likely cause. This is the first real-cluster verification.
- [ ] **3. Scenario test suite.** Fixture scenarios (OOM, bad image, unschedulable, failing probe,
  bad rollout, healthy) each with the expected top likely cause. *Done when:* a test table checks
  the top hypothesis per scenario and reports a simple pass rate.

## Evidence quality

- [ ] **4. Pod logs with redaction.** Add recent log tail (including previous container) to the
  Kubernetes reader, redacted at the boundary, size-capped, as evidence. *Done when:* tests prove
  secrets in logs never reach the timeline and that huge logs are truncated.
- [ ] **5. Ownership chain and rollouts.** Resolve Pod to ReplicaSet to Deployment and add recent
  rollout events as evidence. *Done when:* a bad-rollout scenario surfaces "rollout started at T"
  before the failures it caused.
- [ ] **6. Node, HPA and PVC evidence.** Node conditions (memory/disk pressure), HPA at max
  replicas, PVC pending. *Done when:* each has a fixture, a tag and a hypothesis rule with tests.
- [ ] **7. Loki connector.** Read-only LogQL range queries, same contract as the other connectors.
  *Done when:* it passes the shared connector contract with a fake HTTP server.
- [ ] **8. Finer-grained MCP tools.** Separate tools for pod status, events and a single Prometheus
  check, with per-tool permissions in config. *Done when:* a tool disabled in config is not listed
  and cannot be called.

## Release and operations

- [ ] **9. Releases.** Changesets for versioning and an npm publish workflow with provenance
  (SHA-pinned actions, least-privilege token). *Done when:* a dry-run release workflow passes.
- [ ] **10. Self-observability.** OpenTelemetry traces around each connector call and the
  investigation, off by default. *Done when:* tests assert spans and that no secret appears in
  span attributes.
- [ ] **11. Helm chart and container image.** Dockerfile, a chart with a read-only ClusterRole
  (get/list/watch only), and `helm lint` in CI. *Done when:* the chart's role is asserted to have
  no write verbs.

## Later

- [ ] **12. API with Postgres, Drizzle and an append-only audit log.**
- [ ] **13. Web dashboard with the incident timeline view.**
- [ ] **14. Runbooks as Markdown and a connector plugin interface.**
- [ ] **15. Optional LLM summary layer, off by default,** that only summarises collected evidence and
  cites evidence ids.
- [ ] **16. Actions with approval.** Any mutating action requires an explicit approval step and an
  audit-log entry first. Not to be started before items 12 and 8.
