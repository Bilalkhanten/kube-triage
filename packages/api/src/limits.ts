/**
 * A fixed-window counter per key. In memory, so with several replicas each enforces its own limit.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one request. `firstRejection` is true only for the first rejected request in a window. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number; firstRejection: boolean } {
    const now = this.now();
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    return { allowed: w.count <= this.limit, retryAfterSeconds, firstRejection: w.count === this.limit + 1 };
  }

  /** Keeps memory bounded when many distinct keys (for example IP addresses) pass through. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}

/** Caps how many things run at once. */
export class ConcurrencyGate {
  private running = 0;
  constructor(private readonly max: number) {}

  tryEnter(): boolean {
    if (this.running >= this.max) return false;
    this.running += 1;
    return true;
  }

  leave(): void {
    this.running = Math.max(0, this.running - 1);
  }
}
