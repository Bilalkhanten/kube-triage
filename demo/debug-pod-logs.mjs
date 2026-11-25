// Failure diagnostics for the demo job: shows what the Kubernetes client itself returns when the
// connector's pod log reader asks for the crashlog logs, so a missing log assertion can be traced
// to the transport, the parsing or the matching. Read-only (list pods, read logs).
import { createKubeReader } from "../packages/connectors/dist/index.js";

const context = process.argv[2] ?? "kind-kube-triage-demo";
const reader = createKubeReader({ context, podLogs: true });
const pods = (await reader.listPods("demo")).filter((p) => p.metadata?.name?.startsWith("crashlog-"));
console.log(`crashlog pods: ${pods.length}`);
for (const pod of pods) {
  for (const cs of pod.status?.containerStatuses ?? []) {
    console.log(`container ${cs.name}: restartCount=${cs.restartCount} state=${JSON.stringify(cs.state)} lastState=${JSON.stringify(cs.lastState)}`);
    for (const previous of [true, false]) {
      try {
        const text = await reader.readPodLog({ namespace: "demo", pod: pod.metadata.name, container: cs.name, previous, tailLines: 200 });
        console.log(`readPodLog previous=${previous}: typeof=${typeof text} length=${text?.length} raw=${JSON.stringify(text)?.slice(0, 600)}`);
      } catch (error) {
        console.log(`readPodLog previous=${previous} threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
