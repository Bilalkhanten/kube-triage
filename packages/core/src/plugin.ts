import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Connector } from "./connector.js";

/**
 * A connector plugin turns environment configuration into a read-only connector.
 * Third parties implement this to add a data source without changing kube-triage.
 */
export interface ConnectorPlugin {
  /** Must equal the `name` of the connector it creates. Lowercase letters, digits and hyphens. */
  readonly name: string;
  readonly description: string;
  /** Environment variables the plugin reads. Used for documentation and listings. */
  readonly env: readonly string[];
  /**
   * Builds the connector from the environment, or returns undefined when the plugin is not
   * configured (so it is simply skipped). Throw on configuration that is present but invalid.
   */
  fromEnv(env: NodeJS.ProcessEnv): Connector | undefined;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export class PluginRegistry {
  private readonly plugins = new Map<string, ConnectorPlugin>();

  register(plugin: ConnectorPlugin): this {
    if (!NAME.test(plugin.name)) {
      throw new Error(`Invalid plugin name "${plugin.name}": use lowercase letters, digits and hyphens.`);
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error(`A plugin named "${plugin.name}" is already registered.`);
    }
    this.plugins.set(plugin.name, plugin);
    return this;
  }

  list(): ConnectorPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * Builds a connector for every plugin that is configured. Names listed in
   * `KUBE_TRIAGE_DISABLE` (comma separated) are skipped.
   */
  connectorsFromEnv(env: NodeJS.ProcessEnv): Connector[] {
    const disabled = new Set(
      (env["KUBE_TRIAGE_DISABLE"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const connectors: Connector[] = [];
    for (const plugin of this.plugins.values()) {
      if (disabled.has(plugin.name)) continue;
      const connector = plugin.fromEnv(env);
      if (!connector) continue;
      if (connector.name !== plugin.name) {
        throw new Error(`Plugin "${plugin.name}" created a connector named "${connector.name}".`);
      }
      connectors.push(connector);
    }
    return connectors;
  }
}

export function isConnectorPlugin(value: unknown): value is ConnectorPlugin {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["description"] === "string" &&
    Array.isArray(v["env"]) &&
    typeof v["fromEnv"] === "function"
  );
}

/**
 * Loads a plugin from a module that exports it as `plugin` or as the default export.
 * This runs the module's code with this process's privileges, so only load code you trust.
 */
export async function loadPluginModule(specifier: string): Promise<ConnectorPlugin> {
  // File paths are relative to the caller's working directory, not to this package.
  const isPath = specifier.startsWith(".") || specifier.startsWith("/");
  const target = isPath ? pathToFileURL(resolve(specifier)).href : specifier;
  const mod = (await import(target)) as Record<string, unknown>;
  const candidate = mod["plugin"] ?? mod["default"];
  if (!isConnectorPlugin(candidate)) {
    throw new Error(`Module "${specifier}" does not export a connector plugin as "plugin" or as its default export.`);
  }
  return candidate;
}
