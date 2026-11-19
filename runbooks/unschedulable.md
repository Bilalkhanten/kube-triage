---
title: Pod cannot be scheduled
hypotheses: unschedulable
---
# Pod cannot be scheduled

The scheduler cannot find a node that satisfies the pod (Pending, FailedScheduling).

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>     # the message counts nodes by reason, e.g. "0/3 nodes are available: ..."
```

## Check

- Insufficient CPU or memory: compare the pod's requests with free capacity.

```bash
kubectl describe nodes | grep -A6 "Allocated resources"
```

- Taints without a matching toleration, or node selectors and affinity rules that match nothing.
- A PersistentVolume that can only attach in a different zone from the available nodes.
- Quota exhausted in the namespace: `kubectl describe resourcequota -n <namespace>`.

## Usual fixes (human decisions)

Add capacity, reduce requests, or relax the placement rule.
