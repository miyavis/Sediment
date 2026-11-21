import type { SedimentPlugin } from "../main";
import {
  appDataDirectory,
  ensureDirectory,
  fileExists,
  homeDirectory,
  readTextFile,
  writeTextFile,
} from "../utils/node";
import { BRIDGE_SOURCE } from "./bridge-source";

export interface AgentTarget {
  id: string;
  name: string;
  configPath: string;
  /** OpenCode 用 mcp.environment，其它客户端多用 mcpServers.env */
  rootKey: "mcp" | "mcpServers";
  envKey: "environment" | "env";
}

/**
 * 判定 OpenCode 配置布局：
 * 1. 直挂的 type/command 数组条目 → v1（v1 格式是两版都接受的公共分母，混合配置优先保 v1）；
 * 2. 已有 mcp.servers → v2。
 * 3. 形状无线索（含 Claude 风格残留）时默认 v2；可注入 probe 供调用方按需覆盖。
 * 依据官方迁移文档：v1 直挂 mcp.<name>（enabled/数字 timeout），v2 归入 mcp.servers（disabled/对象 timeout），V2 兼容 V1 条目。
 * 不执行本机命令探测版本：避免插件获得 shell 执行能力，新装客户端按当前 v2 布局写入。
 */
export function detectOpenCodeLayout(data: Record<string, unknown>, probe?: () => number | undefined): "v1" | "v2" {
  const mcp = (data.mcp ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(mcp)) {
    if (key === "servers" || key === "timeout") continue;
    const entry = value as { type?: unknown; command?: unknown } | null;
    if (entry && typeof entry === "object" && (entry.type === "local" || entry.type === "remote" || Array.isArray(entry.command))) {
      return "v1";
    }
  }
  if (mcp.servers && typeof mcp.servers === "object") return "v2";
  return probe?.() === 1 ? "v1" : "v2";
}

/** 候选客户端清单（纯函数，便于测试）。路径均对照各客户端官方文档核实。 */
export function agentCandidates(home: string, appdata: string): AgentTarget[] {
  return [
    { id: "opencode", name: "OpenCode", configPath: `${home}/.config/opencode/opencode.jsonc`, rootKey: "mcp", envKey: "environment" },
    { id: "qoder", name: "Qoder", configPath: `${home}/.qoder/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "qoder-cn", name: "Qoder CN", configPath: `${home}/.qoder-cn/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "claude-desktop", name: "Claude Desktop", configPath: `${appdata}/Claude/claude_desktop_config.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "cursor", name: "Cursor", configPath: `${home}/.cursor/mcp.json`, rootKey: "mcpServers", envKey: "env" },
    // Cline CLI 与 IDE 扩展的配置文件名/位置不同，均非 ~/.cline/mcp_settings.json。
    { id: "cline", name: "Cline CLI", configPath: `${home}/.cline/data/settings/cline_mcp_settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "cline-ide", name: "Cline (VS Code)", configPath: `${appdata}/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "gemini", name: "Gemini CLI", configPath: `${home}/.gemini/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "windsurf", name: "Windsurf", configPath: `${home}/.codeium/windsurf/mcp_config.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "windsurf-next", name: "Windsurf Next", configPath: `${home}/.codeium/windsurf-next/mcp_config.json`, rootKey: "mcpServers", envKey: "env" },
  ];
}

/** 探测本机已存在配置文件的智能体客户端。 */
export function detectAgents(): AgentTarget[] {
  return agentCandidates(homeDirectory(), appDataDirectory()).filter((target) => fileExists(target.configPath));
}

function stripComments(raw: string): string {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
}

function readJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return JSON.parse(stripComments(raw)) as Record<string, unknown>;
  }
}

/** 该客户端是否已经写入过 Sediment 配置（OpenCode 兼容 v1 直挂与 v2 servers 两个位置）。 */
export function isAgentConfigured(target: AgentTarget): boolean {
  if (!fileExists(target.configPath)) return false;
  try {
    const data = readJson(readTextFile(target.configPath, "utf8"));
    const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
    if (target.rootKey === "mcp") {
      const servers = (root.servers ?? {}) as Record<string, unknown>;
      return Boolean(root.sediment || servers.sediment);
    }
    return Boolean(root.sediment);
  } catch {
    return false;
  }
}

/** 优先复用配置里已有的桥接路径，否则找插件目录；库内副本始终与嵌入源码保持同步。 */
export function resolveBridgePath(plugin: SedimentPlugin, target?: AgentTarget): string {
  const adapter = plugin.app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
  const vaultBridge = adapter.getFullPath
    ? adapter.getFullPath(`${plugin.app.vault.configDir}/plugins/sediment/mcp-server/index.mjs`)
    : "";
  const samePath = (a: string, b: string): boolean =>
    a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
  // 库内桥接是插件自有文件：缺失或与嵌入源码不一致（如旧版仍走 ?token= 查询串）时重写。
  // 协议升级后若原样复用旧桥接，服务端只认 Bearer 头会全部 401，一键配置表现为"不生效"。
  // Obsidian 只安装 main.js/manifest.json/styles.css 三件套，桥接脚本不会随插件落盘，由此处补写。
  const syncVaultBridge = (): string => {
    if (!vaultBridge) return "";
    try {
      if (fileExists(vaultBridge) && readTextFile(vaultBridge, "utf8") === BRIDGE_SOURCE) return vaultBridge;
      const sep = Math.max(vaultBridge.lastIndexOf("/"), vaultBridge.lastIndexOf("\\"));
      if (sep > 0) ensureDirectory(vaultBridge.slice(0, sep), { recursive: true });
      writeTextFile(vaultBridge, BRIDGE_SOURCE, "utf8");
      return fileExists(vaultBridge) ? vaultBridge : "";
    } catch {
      return "";
    }
  };
  if (target) {
    try {
      const data = readJson(readTextFile(target.configPath, "utf8"));
      const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
      const servers = (root.servers ?? {}) as Record<string, unknown>;
      // OpenCode 条目可能在 v1 直挂或 v2 servers 位置；路径在 args（Claude 风格）或 command 数组里。
      const entries = [root.sediment, servers.sediment].filter(Boolean) as Array<{ args?: string[]; command?: unknown }>;
      for (const entry of entries) {
        const command = Array.isArray(entry.command) ? entry.command.filter((x): x is string => typeof x === "string") : [];
        const candidates = [...(entry.args ?? []), ...command];
        const existing = candidates.find((arg) => arg.endsWith("index.mjs") && fileExists(arg));
        if (existing) {
          // 引用的正是库内副本时先同步；库外路径属用户自有文件，不覆盖。
          if (vaultBridge && samePath(existing, vaultBridge)) return syncVaultBridge();
          return existing;
        }
      }
    } catch {
      // 沿用默认探测
    }
  }
  return syncVaultBridge();
}

function buildEntry(plugin: SedimentPlugin, target: AgentTarget, bridge: string): Record<string, unknown> {
  const url = `http://127.0.0.1:${plugin.store.settings.agentServerPort}`;
  const entry: Record<string, unknown> = {
    command: "node",
    args: [bridge],
    [target.envKey]: {
      SEDIMENT_URL: url,
      SEDIMENT_TOKEN: plugin.store.settings.agentServerToken,
      AGENT_NAME: target.id,
    },
  };
  // Cline 的 timeout 按秒计，写毫秒值会被误读；其余客户端忽略或按毫秒解释，统一 60000。
  if (!target.id.startsWith("cline")) entry.timeout = 60000;
  return entry;
}

/** OpenCode 专用条目：type:local + command 数组；v1 直挂（enabled/数字 timeout），v2 归入 servers（对象 timeout）。 */
function buildOpenCodeEntry(plugin: SedimentPlugin, target: AgentTarget, bridge: string, layout: "v1" | "v2"): Record<string, unknown> {
  const environment = {
    SEDIMENT_URL: `http://127.0.0.1:${plugin.store.settings.agentServerPort}`,
    SEDIMENT_TOKEN: plugin.store.settings.agentServerToken,
    AGENT_NAME: target.id,
  };
  if (layout === "v1") {
    return { type: "local", command: ["node", bridge], environment, enabled: true, timeout: 60000 };
  }
  return { type: "local", command: ["node", bridge], environment, timeout: { startup: 60000 } };
}

/** 返回可复制的 JSON 片段（OpenCode 按本机版本输出 v1/v2 原生结构）。 */
export function configSnippet(plugin: SedimentPlugin, id = "opencode"): string {
  const isOpenCode = id === "opencode";
  const target: AgentTarget = {
    id,
    name: id,
    configPath: "",
    rootKey: isOpenCode ? "mcp" : "mcpServers",
    envKey: isOpenCode ? "environment" : "env",
  };
  const bridge = resolveBridgePath(plugin);
  if (isOpenCode) {
    const layout = detectOpenCodeLayout({});
    const entry = buildOpenCodeEntry(plugin, target, bridge, layout);
    const mcp = layout === "v2" ? { servers: { sediment: entry } } : { sediment: entry };
    return JSON.stringify({ mcp }, null, 2);
  }
  return JSON.stringify({ [target.rootKey]: { sediment: buildEntry(plugin, target, bridge) } }, null, 2);
}

/** 把 Sediment MCP 配置合并进目标客户端配置，写入前备份。OpenCode 按检测到的 v1/v2 布局写入并清理另一位置的旧条目。 */
export function configureAgent(plugin: SedimentPlugin, target: AgentTarget): void {
  const bridge = resolveBridgePath(plugin, target);
  if (!bridge) throw new Error("找不到 mcp-server/index.mjs，无法配置");
  const raw = readTextFile(target.configPath, "utf8");
  const data = readJson(raw);
  if (target.rootKey === "mcp") {
    const layout = detectOpenCodeLayout(data);
    const mcp = (data.mcp ?? {}) as Record<string, unknown>;
    const entry = buildOpenCodeEntry(plugin, target, bridge, layout);
    if (layout === "v2") {
      const servers = (mcp.servers ?? {}) as Record<string, unknown>;
      servers.sediment = entry;
      mcp.servers = servers;
      delete mcp.sediment;
    } else {
      mcp.sediment = entry;
      const servers = (mcp.servers ?? {}) as Record<string, unknown>;
      delete servers.sediment;
      // 清空的 servers 键移除，避免 v1 把它误读为服务器条目。
      if (Object.keys(servers).length === 0) delete mcp.servers;
      else mcp.servers = servers;
    }
    data.mcp = mcp;
  } else {
    const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
    root.sediment = buildEntry(plugin, target, bridge);
    data[target.rootKey] = root;
  }
  writeTextFile(`${target.configPath}.bak`, raw, "utf8");
  writeTextFile(target.configPath, JSON.stringify(data, null, 2), "utf8");
}
