import { describe, expect, it } from "vitest";
import { ConcurrencyGate, FixedWindowLimiter } from "../src/index.js";

describe("FixedWindowLimiter", () => {
  it("allows up to the limit, then rejects until the window passes", () => {
    let t = 0;
    const limiter = new FixedWindowLimiter(3, 60_000, () => t);
    expect([1, 2, 3].map(() => limiter.hit("k").allowed)).toEqual([true, true, true]);
    const fourth = limiter.hit("k");
    expect(fourth).toMatchObject({ allowed: false, firstRejection: true });
    expect(fourth.retryAfterSeconds).toBe(60);
    expect(limiter.hit("k")).toMatchObject({ allowed: false, firstRejection: false });
    t = 59_000;
    expect(limiter.hit("k").retryAfterSeconds).toBe(1);
    t = 60_000;
    expect(limiter.hit("k").allowed).toBe(true);
  });

  it("counts keys separately", () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("stays bounded under many distinct keys", () => {
    let t = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => t);
    for (let i = 0; i < 10_500; i++) limiter.hit(`ip-${i}`);
    t = 5000;
    limiter.hit("fresh"); // triggers the sweep of expired windows
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThan(10);
  });
});

describe("ConcurrencyGate", () => {
  it("admits up to the maximum and frees slots when they leave", () => {
    const gate = new ConcurrencyGate(2);
    expect([gate.tryEnter(), gate.tryEnter(), gate.tryEnter()]).toEqual([true, true, false]);
    gate.leave();
    expect(gate.tryEnter()).toBe(true);
  });

  it("never goes below zero", () => {
    const gate = new ConcurrencyGate(1);
    gate.leave();
    gate.leave();
    expect([gate.tryEnter(), gate.tryEnter()]).toEqual([true, false]);
  });
});
