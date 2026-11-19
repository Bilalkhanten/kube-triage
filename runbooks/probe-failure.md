---
title: Pod is failing readiness or liveness checks
hypotheses: probe-failure
---
# Pod is failing readiness or liveness checks

The pod is running but not passing its health probes, so it receives no traffic (readiness) or gets restarted (liveness).

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>     # Events: "Readiness probe failed" or "Liveness probe failed" with the reason
```

## Check

- Does the probe path, port and scheme match what the app serves? Try it from your machine:

```bash
kubectl port-forward <pod> -n <namespace> 8080:<port>
curl -i localhost:8080/<probe-path>
```

- Is the app slow to start? Compare `initialDelaySeconds` and `timeoutSeconds` with real start-up time; a startup probe helps.
- Does the health endpoint depend on something that is down (database, cache, upstream)? Then the probe is reporting a real problem elsewhere.
