---
title: Image cannot be pulled
hypotheses: image-pull-failure
---
# Image cannot be pulled

The kubelet cannot fetch the container image (ErrImagePull or ImagePullBackOff).

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>     # the Events section shows the registry error
```

## Check

- Does the image name and tag exist? A typo or a tag that was never pushed is the most common cause.
- Private registry: does the pod reference an `imagePullSecrets` entry, and does that secret exist in the same namespace and still hold valid credentials?

```bash
kubectl get secret -n <namespace>
kubectl get pod <pod> -n <namespace> -o jsonpath='{.spec.imagePullSecrets}'
```

- Public registries can rate limit anonymous pulls.
- Can the node reach the registry (network policy, proxy, DNS)?
