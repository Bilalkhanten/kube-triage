import { defineConfig } from "@playwright/test";
import { API_KEYS, API_PORT, DEAD_API_PORT, VIEWER_KEY, WEB_DOWN_PORT, WEB_PORT } from "./e2e/fixture.mjs";

// Needs a built workspace (pnpm build && pnpm build:web) and a reachable PostgreSQL in DATABASE_URL.
const web = (port, apiPort) => ({
  command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
  url: `http://127.0.0.1:${port}/healthz`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { KUBE_TRIAGE_API_URL: `http://127.0.0.1:${apiPort}`, KUBE_TRIAGE_API_KEY: VIEWER_KEY },
});

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.mjs",
  globalSetup: "./e2e/seed.mjs",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "off" },
  webServer: [
    {
      command: "node ../api/dist/server.js",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: process.env.DATABASE_URL ?? "", KUBE_TRIAGE_API_KEYS: API_KEYS, HOST: "127.0.0.1", PORT: String(API_PORT) },
    },
    web(WEB_PORT, API_PORT),
    web(WEB_DOWN_PORT, DEAD_API_PORT),
  ],
});
