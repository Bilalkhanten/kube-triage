import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HYPOTHESIS_IDS, loadRunbooks, matchRunbooks, parseRunbook, type Hypothesis } from "../src/index.js";

const valid = `---
title: Container is running out of memory
hypotheses: oom-killed, crash-loop
---
# Steps

Do the thing.
`;

describe("parseRunbook", () => {
  it("reads front matter and body", () => {
    const r = parseRunbook(valid, "oom");
    expect(r).toMatchObject({ id: "oom", title: "Container is running out of memory", hypotheses: ["oom-killed", "crash-loop"] });
    expect(r.body).toBe("# Steps\n\nDo the thing.");
  });

  it("accepts a bracketed list and Windows line endings", () => {
    const r = parseRunbook("---\r\ntitle: T\r\nhypotheses: [a, b]\r\n---\r\nbody\r\n", "x");
    expect(r.hypotheses).toEqual(["a", "b"]);
  });

  it.each([
    ["no front matter", "# just markdown", /front matter/],
    ["missing title", "---\nhypotheses: a\n---\nbody", /title/],
    ["missing hypotheses", "---\ntitle: T\n---\nbody", /hypotheses/],
    ["empty body", "---\ntitle: T\nhypotheses: a\n---\n", /body/],
    ["unreadable line", "---\ntitle: T\nnonsense\nhypotheses: a\n---\nbody", /cannot read front matter/],
  ])("rejects %s", (_name, source, message) => {
    expect(() => parseRunbook(source, "x")).toThrow(message);
  });

  it("rejects ids that are not safe file-like names", () => {
    expect(() => parseRunbook(valid, "../etc/passwd")).toThrow(/invalid/);
  });
});

describe("loadRunbooks", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads .md files, ignores README and other files, and does not recurse", async () => {
    dir = await mkdtemp(join(tmpdir(), "runbooks-"));
    await writeFile(join(dir, "oom.md"), valid);
    await writeFile(join(dir, "README.md"), "# not a runbook");
    await writeFile(join(dir, "notes.txt"), "ignored");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "deep.md"), valid);
    expect((await loadRunbooks(dir)).map((r) => r.id)).toEqual(["oom"]);
  });

  it("fails loudly on an invalid or oversized runbook", async () => {
    dir = await mkdtemp(join(tmpdir(), "runbooks-"));
    await writeFile(join(dir, "bad.md"), "no front matter");
    await expect(loadRunbooks(dir)).rejects.toThrow(/bad/);
    await writeFile(join(dir, "bad.md"), valid + "x".repeat(70 * 1024));
    await expect(loadRunbooks(dir)).rejects.toThrow(/larger than/);
  });
});

describe("matchRunbooks", () => {
  const h = (id: string): Hypothesis => ({ id, title: id, confidence: "low", rationale: "r", evidenceIds: ["e"], suggestedChecks: [] });

  it("maps hypotheses to the runbooks that name them", () => {
    const oom = parseRunbook(valid, "oom");
    const matched = matchRunbooks([h("oom-killed"), h("unschedulable")], [oom]);
    expect([...matched.keys()]).toEqual(["oom-killed"]);
    expect(matched.get("oom-killed")).toEqual([oom]);
  });
});

describe("shipped runbooks", () => {
  const dir = fileURLToPath(new URL("../../../runbooks", import.meta.url));

  it("all parse", async () => {
    expect((await loadRunbooks(dir)).length).toBeGreaterThan(0);
  });

  it("cover every hypothesis the engine can produce, and name no unknown ones", async () => {
    const runbooks = await loadRunbooks(dir);
    const covered = new Set(runbooks.flatMap((r) => r.hypotheses));
    for (const id of HYPOTHESIS_IDS) expect(covered, `no runbook for hypothesis "${id}"`).toContain(id);
    for (const id of covered) expect(HYPOTHESIS_IDS, `runbook names unknown hypothesis "${id}"`).toContain(id);
  });
});
