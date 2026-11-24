#!/usr/bin/env bash
# Brings up the demo on a local kind cluster and investigates it with the built CLI.
# Requires: kind, kubectl, node 22+, and `pnpm build` already run. Creates and uses only the
# kind cluster "kube-triage-demo"; `demo/run.sh down` deletes it.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=kube-triage-demo
CONTEXT="kind-${CLUSTER}"

if [ "${1:-}" = "down" ]; then
  kind delete cluster --name "$CLUSTER"
  exit 0
fi

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config demo/kind-config.yaml --wait 120s
fi
kubectl --context "$CONTEXT" apply -f demo/manifests/monitoring.yaml -f demo/manifests/apps.yaml
kubectl --context "$CONTEXT" -n monitoring rollout status deploy/kube-state-metrics deploy/prometheus --timeout=240s

# Give the broken apps time to fail: wait until the pods show the expected reasons.
deadline=$((SECONDS + 300))
until [ "$(kubectl --context "$CONTEXT" -n demo get pods -o json | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const pods=JSON.parse(s).items; const st=pods.flatMap(p=>p.status.containerStatuses??[]);
    const oom=st.some(c=>c.lastState?.terminated?.reason==="OOMKilled");
    const img=st.some(c=>["ErrImagePull","ImagePullBackOff"].includes(c.state?.waiting?.reason));
    const probe=pods.some(p=>p.metadata.name.startsWith("badprobe-")&&st.some(c=>c.restartCount>0));
    const logc=pods.some(p=>p.metadata.name.startsWith("crashlog-")&&st.some(c=>c.restartCount>0));
    console.log(oom&&img&&probe&&logc?"ready":"waiting");
  });')" = "ready" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Timed out waiting for the broken apps to fail" >&2
    kubectl --context "$CONTEXT" -n demo get pods >&2
    exit 1
  fi
  sleep 5
done
# Let Prometheus scrape the restarts at least twice.
sleep 20

kubectl --context "$CONTEXT" -n monitoring port-forward svc/prometheus 19090:9090 >/dev/null 2>&1 &
pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:19090/-/ready >/dev/null && break; sleep 1; done

KUBE_TRIAGE_POD_LOGS=1 node packages/cli/dist/bin.js investigate -n demo --since 30m \
  --context "$CONTEXT" --prometheus-url http://127.0.0.1:19090 \
  --runbooks runbooks --json > demo-timeline.json
node demo/assert-timeline.mjs < demo-timeline.json
