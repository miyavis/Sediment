import type { SedimentPlugin } from "../main";
import { fileExists, readTextFile, removePath, writeTextFile } from "../utils/node";
import { detectAgents, isAgentConfigured, type AgentTarget } from "../agent/setup";
import { removeTomlServer, removeYamlServer } from "../agent/config-formats";
import { tf } from "../i18n";

function readJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface McpInstallation {
  id: string;
  label: string;
  configPath: string;
  rootKey: AgentTarget["rootKey"];
  configured: boolean;
}

/** 探测哪些客户端配置里写了 sediment MCP，以及桥接脚本是否存在。 */
export function listMcpInstallations(plugin: SedimentPlugin): {
  clients: McpInstallation[];
  bridgePath: string;
  bridgeExists: boolean;
} {
  const adapter = plugin.app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
  const bridgePath = adapter?.getFullPath?.(
    `${plugin.app.vault.configDir}/plugins/sediment/mcp-server/index.mjs`
  ) ?? "";
  const clients: McpInstallation[] = [];
  for (const target of detectAgents()) {
    const configured = isAgentConfigured(target);
    clients.push({
      id: target.id,
      label: target.name,
      configPath: target.configPath,
      rootKey: target.rootKey,
      configured,
    });
  }
  return { clients, bridgePath, bridgeExists: Boolean(bridgePath && fileExists(bridgePath)) };
}

/** 从选中的客户端配置中移除 sediment 条目；写前备份为 .bak。 */
function removeFromClient(target: AgentTarget): boolean {
  if (!fileExists(target.configPath)) return false;
  const raw = readTextFile(target.configPath, "utf8");
  if (target.format === "toml") {
    const updated = removeTomlServer(raw, "sediment");
    if (updated === raw) return false;
    writeTextFile(`${target.configPath}.bak`, raw, "utf8");
    writeTextFile(target.configPath, updated, "utf8");
    return true;
  }
  if (target.format === "yaml") {
    const updated = removeYamlServer(raw, "sediment");
    if (updated === raw) return false;
    writeTextFile(`${target.configPath}.bak`, raw, "utf8");
    writeTextFile(target.configPath, updated, "utf8");
    return true;
  }
  const data = readJson(raw);
  if (!data) return false;
  const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
  const servers = (root.servers ?? {}) as Record<string, unknown>;
  if (!root.sediment && !servers.sediment) return false;
  delete root.sediment;
  if (servers.sediment) {
    delete servers.sediment;
    if (Object.keys(servers).length === 0) delete root.servers;
    else root.servers = servers;
  }
  data[target.rootKey] = root;
  writeTextFile(`${target.configPath}.bak`, raw, "utf8");
  writeTextFile(target.configPath, JSON.stringify(data, null, 2), "utf8");
  return true;
}

/** 一键卸载：移除客户端配置与桥接脚本，不触碰任何笔记或统计数据。 */
export function uninstallMcp(
  plugin: SedimentPlugin,
  selectedClientIds: string[],
  removeBridge: boolean
): { clients: number; bridge: boolean; failures: string[] } {
  const failures: string[] = [];
  let clients = 0;
  let bridge = false;

  const state = listMcpInstallations(plugin);
  for (const target of detectAgents()) {
    if (!selectedClientIds.includes(target.id)) continue;
    try {
      if (removeFromClient(target)) clients += 1;
    } catch (error) {
      failures.push(tf("{name}：{detail}", { name: target.name, detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  if (removeBridge && state.bridgePath) {
    try {
      const sep = Math.max(state.bridgePath.lastIndexOf("/"), state.bridgePath.lastIndexOf("\\"));
      const dir = state.bridgePath.slice(0, sep);
      removePath(state.bridgePath, { recursive: true, force: true });
      removePath(dir, { recursive: true, force: true });
      bridge = true;
    } catch (error) {
      failures.push(tf("桥接脚本：{detail}", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { clients, bridge, failures };
}
