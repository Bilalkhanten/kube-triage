import { describe, expect, it } from "vitest";
import { ApiKeyAuthenticator, generateKey, hasRole, hashKey } from "../src/index.js";

describe("API keys", () => {
  const viewer = generateKey();
  const admin = generateKey();
  const auth = new ApiKeyAuthenticator([
    { id: "dashboard", sha256: viewer.sha256, role: "viewer" },
    { id: "ops", sha256: admin.sha256, role: "admin" },
  ]);

  it("generates distinct, well-formed keys whose hash matches", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.token).toMatch(/^kt_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.sha256).toBe(hashKey(a.token));
  });

  it("authenticates a valid bearer key and returns its id and role", () => {
    expect(auth.authenticate(`Bearer ${viewer.token}`)).toEqual({ id: "dashboard", role: "viewer" });
    expect(auth.authenticate(`Bearer ${admin.token}`)).toEqual({ id: "ops", role: "admin" });
  });

  it.each([undefined, "", "Bearer", "Bearer ", "Basic abc", "bearer lowercase", "Bearer wrong-key", "Bearer a b"])("rejects %j", (header) => {
    expect(auth.authenticate(header)).toBeUndefined();
  });

  it("orders roles", () => {
    expect(hasRole("admin", "viewer")).toBe(true);
    expect(hasRole("investigator", "investigator")).toBe(true);
    expect(hasRole("viewer", "investigator")).toBe(false);
    expect(hasRole("investigator", "admin")).toBe(false);
  });

  it("rejects bad configuration", () => {
    expect(() => new ApiKeyAuthenticator([])).toThrow();
    expect(() => new ApiKeyAuthenticator([{ id: "a", sha256: "short", role: "viewer" }])).toThrow();
    expect(() => new ApiKeyAuthenticator([{ id: "a", sha256: viewer.sha256, role: "root" }])).toThrow();
    expect(() => new ApiKeyAuthenticator([
      { id: "a", sha256: viewer.sha256, role: "viewer" },
      { id: "a", sha256: admin.sha256, role: "admin" },
    ])).toThrow(/unique/);
  });

  it("refuses to start without keys or with invalid JSON", () => {
    expect(() => ApiKeyAuthenticator.fromEnv({})).toThrow(/not set/);
    expect(() => ApiKeyAuthenticator.fromEnv({ KUBE_TRIAGE_API_KEYS: "{nope" })).toThrow(/valid JSON/);
    const ok = ApiKeyAuthenticator.fromEnv({ KUBE_TRIAGE_API_KEYS: JSON.stringify([{ id: "a", sha256: viewer.sha256, role: "viewer" }]) });
    expect(ok.authenticate(`Bearer ${viewer.token}`)?.id).toBe("a");
  });
});
