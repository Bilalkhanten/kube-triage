---
title: Container is running out of memory
hypotheses: oom-killed
---
# Container is running out of memory

The container hit its memory limit and was killed, or is close to it. These steps only read
state. Any change (raising a limit, restarting a pod) is your decision; kube-triage does not make it.

## Confirm

```bash
kubectl describe pod <pod> -n <namespace>     # Last State: Terminated, Reason: OOMKilled, Exit Code: 137
kubectl top pod <pod> -n <namespace> --containers
```

Compare the working set with the container's memory limit. A steady climb suggests a leak;
a sudden jump suggests a spike in traffic or a large request.

## Check

- Did memory use start rising after a deploy? Compare with the change timeline above.
- JVM and similar runtimes: is the heap sized relative to the container limit, with headroom for non-heap memory?
- Is the limit simply too low for current load?

## Usual fixes (human decisions)

- Raise the memory limit and request to match real usage.
- Fix the leak or reduce per-request memory.
- Set runtime memory flags relative to the container limit.
