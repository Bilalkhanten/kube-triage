// Shared constants for the dashboard end-to-end test. The key is a throwaway used only against
// the API this test starts itself.
import { createHash } from "node:crypto";

export const API_PORT = 18080;
export const WEB_PORT = 13000;
/** A second dashboard whose API URL points at a closed port, to exercise the error page. */
export const WEB_DOWN_PORT = 13001;
export const DEAD_API_PORT = 18999;

export const VIEWER_KEY = "kt_e2e_viewer_key_not_a_secret";
export const API_KEYS = JSON.stringify([{ id: "e2e-viewer", role: "viewer", sha256: createHash("sha256").update(VIEWER_KEY).digest("hex") }]);

export const INCIDENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const INCIDENT_TITLE = "checkout is crash-looping after an OOM kill";
export const CAUSE_TITLE = "Container killed for exceeding its memory limit";
export const EVIDENCE_SUMMARY = "checkout-7d9f was OOMKilled (exit code 137)";

const t = (minutes) => new Date(Date.UTC(2026, 0, 15, 12, minutes)).toISOString();

export const TIMELINE = {
  scope: { namespace: "shop", service: "checkout", from: t(0), to: t(30) },
  generatedAt: t(30),
  entries: [
    {
      id: "k8s-oom-1",
      source: "kubernetes",
      kind: "k8s.pod.container-state",
      observedAt: t(10),
      severity: "critical",
      summary: EVIDENCE_SUMMARY,
      subject: { kind: "Pod", name: "checkout-7d9f", namespace: "shop" },
      tags: ["oom-killed"],
      data: {},
    },
  ],
  hypotheses: [
    {
      id: "oom-killed",
      title: CAUSE_TITLE,
      confidence: "high",
      rationale: "The container terminated with reason OOMKilled.",
      evidenceIds: ["k8s-oom-1"],
      suggestedChecks: ["Compare memory usage with the container limit"],
    },
  ],
  errors: [],
};
