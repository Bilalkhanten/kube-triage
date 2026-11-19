---
title: Container is crash looping
hypotheses: crash-loop
---
# Container is crash looping

A container keeps exiting and Kubernetes keeps restarting it with a growing back-off.

## Confirm

```bash
kubectl logs <pod> -n <namespace> --previous      # output of the crashed run
kubectl describe pod <pod> -n <namespace>         # exit code, last state, probe failures
```

## Read the exit code

| Exit code | Usual meaning |
| --- | --- |
| 1 | The application hit an error and quit |
| 137 | Killed with SIGKILL, often out of memory (see the out-of-memory runbook) |
| 139 | Segmentation fault |
| 143 | Terminated with SIGTERM, for example by a failing liveness probe |

## Check

- The last lines of the previous logs usually name the cause (missing config, unreachable dependency, bad migration).
- Is a liveness probe killing a slow starter? Compare its timing with the app's start time.
- Did it start crashing right after a deploy? See the recent-change runbook.
