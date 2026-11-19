---
title: Container cannot start because of its configuration
hypotheses: config-error
---
# Container cannot start because of its configuration

The container could not be created (CreateContainerConfigError or CreateContainerError), usually
because something it references is missing or invalid.

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>     # the message names the missing object or key
```

## Check

- A referenced ConfigMap or Secret does not exist, or lacks the key the pod asks for.

```bash
kubectl get configmap,secret -n <namespace>
```

- A volume mount path, subPath or security context is invalid.
- The object was deleted or renamed in a recent change; compare with the deploy timeline.
