import { describe, expect, it } from "vitest";
import { redactSecrets, redactValue } from "../src/index.js";

describe("redactSecrets", () => {
  it.each([
    ["Authorization: Bearer abc.def-123", "abc.def-123"],
    ["password=hunter2 next", "hunter2"],
    ['{"api_key": "sk-live-123456"}', "sk-live-123456"],
    ["connect to postgres://admin:s3cret@db:5432/app", "s3cret"],
    ["key AKIAABCDEFGHIJKLMNOP leaked", "AKIAABCDEFGHIJKLMNOP"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "eyJhbGciOiJIUzI1NiJ9"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", "MIIB"],
  ])("removes the secret from %j", (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    const text = "Back-off restarting failed container web in pod web-1";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactValue", () => {
  it("drops values under sensitive keys and cleans nested strings", () => {
    const out = redactValue({
      env: { DB_PASSWORD: "hunter2", REGION: "eu" },
      lines: ["token=abc123", "fine"],
    });
    expect(out.env.DB_PASSWORD).toBe("[REDACTED]");
    expect(out.env.REGION).toBe("eu");
    expect(out.lines).toEqual(["token=[REDACTED]", "fine"]);
  });
});
