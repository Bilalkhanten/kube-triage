import { describe, expect, it } from "vitest";
import { PluginRegistry, isConnectorPlugin, type Connector, type ConnectorPlugin } from "../src/index.js";

const connector = (name: string): Connector => ({ name, collect: async () => [] });

const plugin = (name: string, fromEnv: ConnectorPlugin["fromEnv"]): ConnectorPlugin => ({
  name,
  description: `${name} plugin`,
  env: [],
  fromEnv,
});

describe("PluginRegistry", () => {
  it("builds connectors only for plugins that are configured", () => {
    const registry = new PluginRegistry()
      .register(plugin("alpha", (env) => (env["ALPHA_URL"] ? connector("alpha") : undefined)))
      .register(plugin("beta", () => connector("beta")));
    expect(registry.connectorsFromEnv({}).map((c) => c.name)).toEqual(["beta"]);
    expect(registry.connectorsFromEnv({ ALPHA_URL: "x" }).map((c) => c.name)).toEqual(["alpha", "beta"]);
  });

  it("skips plugins named in KUBE_TRIAGE_DISABLE", () => {
    const registry = new PluginRegistry().register(plugin("alpha", () => connector("alpha"))).register(plugin("beta", () => connector("beta")));
    expect(registry.connectorsFromEnv({ KUBE_TRIAGE_DISABLE: " alpha ,gamma" }).map((c) => c.name)).toEqual(["beta"]);
  });

  it("rejects duplicate and invalid names", () => {
    const registry = new PluginRegistry().register(plugin("alpha", () => undefined));
    expect(() => registry.register(plugin("alpha", () => undefined))).toThrow(/already registered/);
    expect(() => registry.register(plugin("Bad Name", () => undefined))).toThrow(/Invalid plugin name/);
  });

  it("rejects a plugin whose connector has a different name", () => {
    const registry = new PluginRegistry().register(plugin("alpha", () => connector("other")));
    expect(() => registry.connectorsFromEnv({})).toThrow(/named "other"/);
  });

  it("lets configuration errors surface instead of hiding them", () => {
    const registry = new PluginRegistry().register(
      plugin("alpha", () => {
        throw new Error("ALPHA_URL is not a URL");
      }),
    );
    expect(() => registry.connectorsFromEnv({})).toThrow(/ALPHA_URL/);
  });
});

describe("isConnectorPlugin", () => {
  it("accepts well-formed plugins and rejects everything else", () => {
    expect(isConnectorPlugin(plugin("alpha", () => undefined))).toBe(true);
    expect(isConnectorPlugin({ name: "x" })).toBe(false);
    expect(isConnectorPlugin(null)).toBe(false);
    expect(isConnectorPlugin("plugin")).toBe(false);
  });
});

describe("loadPluginModule", () => {
  it("loads a plugin module and the connector it builds", async () => {
    const { loadPluginModule } = await import("../src/index.js");
    const url = new URL("./fixtures/example-plugin.mjs", import.meta.url).href;
    const plugin = await loadPluginModule(url);
    expect(plugin.name).toBe("example");
    expect(plugin.fromEnv({})).toBeUndefined();
    const connector = plugin.fromEnv({ EXAMPLE_ENABLED: "1" });
    expect(connector?.name).toBe("example");
    const evidence = await connector!.collect({ namespace: "shop", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" });
    expect(evidence[0]?.id).toBe("example:hello");
  });

  it("resolves relative file paths against the working directory", async () => {
    const { loadPluginModule } = await import("../src/index.js");
    const { relative } = await import("node:path");
    const rel = "./" + relative(process.cwd(), new URL("./fixtures/example-plugin.mjs", import.meta.url).pathname);
    expect((await loadPluginModule(rel)).name).toBe("example");
  });

  it("rejects a module that is not a plugin", async () => {
    const { loadPluginModule } = await import("../src/index.js");
    await expect(loadPluginModule("node:path")).rejects.toThrow(/does not export a connector plugin/);
  });
});
