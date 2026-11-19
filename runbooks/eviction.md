---
title: Pod was evicted from its node
hypotheses: eviction
---
# Pod was evicted from its node

The node ran short of a resource (memory, disk, inodes) and evicted pods to recover.

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>              # Status: Failed, Reason: Evicted, with the message
kubectl describe node <node>                            # Conditions: MemoryPressure, DiskPressure, PIDPressure
kubectl get events -n <namespace> --field-selector reason=Evicted
```

## Check

- Pods without memory requests are evicted first. Setting requests equal to limits gives the Guaranteed class.
- Disk pressure: large logs or ephemeral storage use on the node.
- Several pods evicted at the same time points at the node, not at your workload.
