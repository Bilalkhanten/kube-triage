---
title: Application is logging errors
hypotheses: app-errors
---
# Application is logging errors

Error-level messages appear in the logs inside the investigated window. The timeline lists each
distinct message once, with a count and the time it first appeared.

## Check

- Read the first occurrence of each pattern, then compare its time with the first failure and with any deploy.
- Does the message point at a dependency (connection refused, timeout, DNS failure)? Check that dependency next.
- Does the count keep climbing, or did it stop? A burst that ended may already be resolved.

Full log context:

```bash
kubectl logs <pod> -n <namespace> --since=1h
kubectl logs <pod> -n <namespace> --previous
```
