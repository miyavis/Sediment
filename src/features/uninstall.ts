import type { SedimentPlugin } from "../main";
import { detectAgents, type AgentTarget } from "../agent/setup";

interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  writeFileSync(path: string, data: string, encoding: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

function nodeFs(): FsModule | null {
  try {
    return require("fs") as FsModule;
  } catch (error) {
    return null;
  }
}

function readJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return null;
  }
}

export interface McpInstallation {
  id: string;
  label: string;
  configPath: string;
  rootKey: "mcp" | "mcpServers";
  configured: boolean;
}

/** 探测哪些客户端配置里写了 sediment MCP，以及桥接脚本是否存在。 */
export function listMcpInstallations(plugin: SedimentPlugin): {
  clients: McpInstallation[];
  bridgePath: string;
  bridgeExists: boolean;
} {
  const fs = nodeFs();
  const adapter = plugin.app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
  const bridgePath = adapter?.getFullPath?.(
    `${plugin.app.vault.configDir}/plugins/sediment/mcp-server/index.mjs`
  ) ?? "";
  const clients: McpInstallation[] = [];
  for (const target of detectAgents()) {
    let configured = false;
    if (fs && fs.existsSync(target.configPath)) {
      const data = readJson(fs.readFileSync(target.configPath, "utf8"));
      const root = (data?.[target.rootKey] ?? {}) as Record<string, unknown>;
      configured = Boolean(root.sediment);
    }
    clients.push({
      id: target.id,
      label: target.name,
      configPath: target.configPath,
      rootKey: target.rootKey,
      configured,
    });
  }
  return { clients, bridgePath, bridgeExists: Boolean(fs && bridgePath && fs.existsSync(bridgePath)) };
}

/** 从选中的客户端配置中移除 sediment 条目；写前备份为 .bak。 */
function removeFromClient(target: AgentTarget, fs: FsModule): boolean {
  if (!fs.existsSync(target.configPath)) return false;
  const raw = fs.readFileSync(target.configPath, "utf8");
  const data = readJson(raw);
  if (!data) return false;
  const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
  if (!root.sediment) return false;
  delete root.sediment;
  data[target.rootKey] = root;
  fs.writeFileSync(`${target.configPath}.bak`, raw, "utf8");
  fs.writeFileSync(target.configPath, JSON.stringify(data, null, 2), "utf8");
  return true;
}

/** 一键卸载：移除客户端配置与桥接脚本，不触碰任何笔记或统计数据。 */
export function uninstallMcp(
  plugin: SedimentPlugin,
  selectedClientIds: string[],
  removeBridge: boolean
): { clients: number; bridge: boolean; failures: string[] } {
  const fs = nodeFs();
  const failures: string[] = [];
  let clients = 0;
  let bridge = false;

  if (!fs) return { clients, bridge, failures: ["当前环境不支持文件操作"] };
  const state = listMcpInstallations(plugin);
  for (const target of detectAgents()) {
    if (!selectedClientIds.includes(target.id)) continue;
    try {
      if (removeFromClient(target, fs)) clients += 1;
    } catch (error) {
      failures.push(`${target.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (removeBridge && state.bridgePath) {
    try {
      const sep = Math.max(state.bridgePath.lastIndexOf("/"), state.bridgePath.lastIndexOf("\\"));
      const dir = state.bridgePath.slice(0, sep);
      fs.rmSync(state.bridgePath, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      bridge = true;
    } catch (error) {
      failures.push(`桥接脚本：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { clients, bridge, failures };
}
