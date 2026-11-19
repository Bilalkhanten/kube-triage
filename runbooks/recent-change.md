---
title: Problems began shortly after a change
hypotheses: recent-change
---
# Problems began shortly after a change

The first problem followed a deployment or rollout closely. That is correlation, not proof; confirm before acting.

## Confirm

```bash
kubectl rollout history deployment/<name> -n <namespace>
kubectl rollout status deployment/<name> -n <namespace>
```

Compare what the change contained (the commit or release named in the timeline) with what is failing.

## Check

- Did every failing pod come from the new ReplicaSet, while the old one was healthy?
- Did a configuration or dependency change ship together with the code?
- Did anything else change at the same time (traffic, a dependency, a node pool)?

## Usual fixes (human decisions)

If the change is the cause, rolling back is the usual remedy. kube-triage never does that itself.
