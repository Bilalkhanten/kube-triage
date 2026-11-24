// Checks an investigation of the demo namespace against what the broken apps should produce.
// Used by demo/run.sh against a live cluster, and by a unit test against a fixture.

/** What each broken app must produce: a likely cause, and evidence about a pod of that app. */
export const EXPECTED = [
  { app: "oom", cause: "oom-killed" },
  { app: "badimage", cause: "image-pull-failure" },
  { app: "badprobe", cause: "probe-failure" },
];

/** Pod log reading (KUBE_TRIAGE_POD_LOGS=1): the app whose log line explains its crash, and that line. */
export const LOG_EXPECTED = { app: "crashlog", message: "payment backend unreachable", secret: "demo-not-a-real-secret" };

/** @returns {string[]} human-readable failures; empty when the timeline is as expected. */
export function checkTimeline(timeline) {
  const failures = [];
  const hypotheses = Array.isArray(timeline?.hypotheses) ? timeline.hypotheses : [];
  const entries = Array.isArray(timeline?.entries) ? timeline.entries : [];
  const ids = new Set(entries.map((e) => e.id));

  for (const { app, cause } of EXPECTED) {
    const h = hypotheses.find((x) => x.id === cause);
    if (!h) {
      failures.push(`missing likely cause "${cause}" (for app ${app})`);
      continue;
    }
    const cited = entries.filter((e) => h.evidenceIds.includes(e.id));
    if (!cited.some((e) => e.subject?.name?.startsWith(`${app}-`))) {
      failures.push(`likely cause "${cause}" does not cite evidence about a pod of ${app}`);
    }
  }
  for (const h of hypotheses) {
    if (h.evidenceIds.some((id) => !ids.has(id))) failures.push(`likely cause "${h.id}" cites evidence that is not in the timeline`);
  }
  const logs = entries.filter((e) => e.kind === "k8s.pod.log-pattern" && e.subject?.name?.startsWith(`${LOG_EXPECTED.app}-`));
  if (!logs.some((e) => e.summary.includes(LOG_EXPECTED.message))) {
    failures.push(`no pod log evidence about ${LOG_EXPECTED.app} containing "${LOG_EXPECTED.message}"`);
  }
  if (JSON.stringify(timeline).includes(LOG_EXPECTED.secret)) failures.push("a secret from a pod log reached the timeline unredacted");
  const sources = new Set(entries.map((e) => e.source));
  if (!sources.has("kubernetes")) failures.push("no evidence from the kubernetes connector");
  if (!sources.has("prometheus")) failures.push("no evidence from the prometheus connector");
  for (const err of timeline?.errors ?? []) failures.push(`connector error from ${err.source}: ${err.message}`);
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const failures = checkTimeline(JSON.parse(input));
  if (failures.length > 0) {
    console.error(`Demo assertions failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Demo assertions passed (${EXPECTED.length} expected causes and the pod log evidence found).`);
}
