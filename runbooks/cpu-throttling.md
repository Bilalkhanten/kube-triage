---
title: CPU is being throttled
hypotheses: cpu-throttling
---
# CPU is being throttled

The container is hitting its CPU limit, which adds latency without any crash.

## Confirm

The throttling ratio over time:

```promql
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="<namespace>"}[5m]))
  / sum by (pod) (rate(container_cpu_cfs_periods_total{namespace="<namespace>"}[5m]))
```

## Check

- Compare CPU usage with the limit. Sustained usage close to the limit means it is too low.
- Brief bursts at start-up or during garbage collection can throttle even when average usage is low.

## Usual fixes (human decisions)

Raise the CPU limit, or follow your platform's policy on CPU limits. Add replicas if load is the cause.
