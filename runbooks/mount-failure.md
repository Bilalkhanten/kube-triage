---
title: Volume cannot be mounted
hypotheses: mount-failure
---
# Volume cannot be mounted

A volume failed to attach or mount, so the pod cannot start (FailedMount, FailedAttachVolume).

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>      # Events show the mount or attach error
kubectl describe pvc <claim> -n <namespace>
kubectl get pv
```

## Check

- Is the PersistentVolumeClaim Bound? A Pending claim points at the storage class or provisioner.
- A volume still attached to another node (for example after a node failure) can block a new attach.
- The referenced Secret or ConfigMap for a volume does not exist.
- The storage backend is unhealthy or out of capacity.
