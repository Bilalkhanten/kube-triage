import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/index.js";

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["30m", 1_800_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("parses %s", (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(["", "5", "m", "1w", "-5m", "0m"])("rejects %j", (input) => expect(() => parseDuration(input)).toThrow());
});
