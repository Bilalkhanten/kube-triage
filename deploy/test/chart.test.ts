import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Static checks on the Helm chart and Dockerfiles. They run without Helm or Docker, so a broken
 * or over-permissive chart fails here; CI additionally runs `helm lint` and `docker build`.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const chartDir = join(root, "helm/kube-triage");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const values = parse(read(chartDir, "values.yaml")) as Record<string, any>;
const templates = readdirSync(join(chartDir, "templates")).map((name) => ({ name, text: read(chartDir, "templates", name) }));

function lookup(obj: Record<string, any>, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("RBAC", () => {
  const helpers = templates.find((t) => t.name === "_helpers.tpl")!.text;
  const block = /{{- define "kube-triage\.readOnlyRules" -}}\n([\s\S]*?)\n{{- end -}}/.exec(helpers);
  // Drop template directives ({{- if ... }}, {{- end }}) so every optional rule is parsed and checked too.
  const plain = (block?.[1] ?? "").split("\n").filter((l) => !l.trim().startsWith("{{")).join("\n");
  const rules = parse(plain) as Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>;

  it("defines a rule list that parses", () => {
    expect(Array.isArray(rules) && rules.length > 0).toBe(true);
  });

  it("only ever grants get, list and watch", () => {
    for (const rule of rules) {
      expect(rule.verbs.length).toBeGreaterThan(0);
      for (const verb of rule.verbs) expect(["get", "list", "watch"], `verb ${verb}`).toContain(verb);
    }
  });

  it("uses no wildcards and never grants Secrets", () => {
    for (const rule of rules) {
      expect([...rule.apiGroups, ...rule.resources, ...rule.verbs]).not.toContain("*");
      expect(rule.resources).not.toContain("secrets");
      expect(rule.resources).not.toContain("pods/exec");
      expect(rule.resources).not.toContain("pods/portforward");
      expect(rule.resources).not.toContain("pods/attach");
    }
  });

  it("grants pod logs only as a single read, and only when switched on", () => {
    const logRule = rules.find((r) => r.resources.includes("pods/log"));
    expect(logRule?.verbs).toEqual(["get"]);
    expect(values["rbac"].podLogs).toBe(false);
    expect(helpers).toMatch(/{{- if \.Values\.rbac\.podLogs }}\n- apiGroups: \[""\]\n  resources: \["pods\/log"\]/);
    expect(templates.find((t) => t.name === "api.yaml")!.text).toContain("KUBE_TRIAGE_POD_LOGS");
  });

  it("is the only place permissions are written", () => {
    for (const t of templates.filter((t) => t.name !== "_helpers.tpl")) {
      expect(t.text, t.name).not.toMatch(/^\s*verbs:/m);
    }
  });
});

describe("templates", () => {
  it("only reference values that exist in values.yaml", () => {
    const missing: string[] = [];
    for (const t of templates) {
      for (const m of t.text.matchAll(/\.Values((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g)) {
        const path = (m[1] as string).slice(1).split(".");
        if (lookup(values, path) === undefined) missing.push(`${t.name}: .Values.${path.join(".")}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("have balanced if/with/range/define blocks", () => {
    for (const t of templates) {
      const opens = [...t.text.matchAll(/{{-?\s*(if|with|range|define|block)\b/g)].length;
      const ends = [...t.text.matchAll(/{{-?\s*end\b/g)].length;
      expect(ends, t.name).toBe(opens);
    }
  });

  it("never create a Secret", () => {
    for (const t of templates) expect(t.text, t.name).not.toMatch(/^kind:\s*Secret\b/m);
  });

  it("give the dashboard no service account token", () => {
    expect(templates.find((t) => t.name === "web.yaml")!.text).toContain("automountServiceAccountToken: false");
  });

  it("probe a health route that does not depend on other services", () => {
    expect(templates.find((t) => t.name === "web.yaml")!.text).toContain("path: /healthz");
    expect(templates.find((t) => t.name === "api.yaml")!.text).toContain("path: /healthz");
  });

  it("require secrets to be supplied by name instead of embedding them", () => {
    const api = templates.find((t) => t.name === "api.yaml")!.text;
    expect(api).toContain("required");
    expect(api).toContain("secretKeyRef");
  });
});

describe("default values", () => {
  it("run as non-root with a locked-down container", () => {
    expect(values["podSecurityContext"].runAsNonRoot).toBe(true);
    expect(values["containerSecurityContext"]).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true });
    expect(values["containerSecurityContext"].capabilities.drop).toEqual(["ALL"]);
  });

  it("keep services private and contain no secret material", () => {
    expect(values["service"].type).toBe("ClusterIP");
    expect(values["api"].database.existingSecret).toBe("");
    expect(values["api"].apiKeys.existingSecret).toBe("");
    expect(values["web"].apiKey.existingSecret).toBe("");
    expect(JSON.stringify(values)).not.toMatch(/kt_[A-Za-z0-9_-]{20,}|postgres:\/\/[^"]*:[^"@]+@/);
  });

  it("have a CI values file that satisfies every required value", () => {
    const ci = parse(read(chartDir, "ci/lint-values.yaml")) as Record<string, any>;
    expect(ci["api"].database.existingSecret).not.toBe("");
    expect(ci["api"].apiKeys.existingSecret).not.toBe("");
    expect(ci["web"].apiKey.existingSecret).not.toBe("");
  });
});

describe("Dockerfiles", () => {
  for (const name of ["api", "web"]) {
    const text = read(root, "docker", `${name}.Dockerfile`);
    it(`${name} runs as an unprivileged user and pins a version tag`, () => {
      expect(text).toMatch(/^USER node$/m);
      for (const from of text.matchAll(/^FROM (\S+)/gm)) expect(from[1], "base image").toMatch(/:\d/);
      expect(text).not.toMatch(/:latest/);
    });
  }
});
