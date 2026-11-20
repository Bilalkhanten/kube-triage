import type { ToolPermissions } from "./server.js";

/**
 *   KUBE_TRIAGE_MCP_TOOLS    comma separated tool names to enable, or "all". Default: investigate
 *   KUBE_TRIAGE_MCP_DISABLE  comma separated tool names to remove
 */
export function toolPermissionsFromEnv(env: NodeJS.ProcessEnv): ToolPermissions {
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const enable = list(env["KUBE_TRIAGE_MCP_TOOLS"]);
  return {
    ...(enable.length === 1 && enable[0] === "all" ? { enable: "all" as const } : enable.length > 0 ? { enable } : {}),
    disable: list(env["KUBE_TRIAGE_MCP_DISABLE"]),
  };
}
