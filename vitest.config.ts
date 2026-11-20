import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source so no build step is needed first.
    alias: {
      "@kube-triage/core": src("core"),
      "@kube-triage/connectors": src("connectors"),
      "@kube-triage/cli": src("cli"),
      "@kube-triage/api": src("api"),
      "@kube-triage/mcp-server": src("mcp-server"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts", "deploy/test/**/*.test.ts", "demo/test/**/*.test.ts"] },
});
