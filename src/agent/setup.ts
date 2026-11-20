import type { SedimentPlugin } from "../main";
import { BRIDGE_SOURCE } from "./bridge-source";

export interface AgentTarget {
  id: string;
  name: string;
  configPath: string;
  /** OpenCode 用 mcp.environment，其它客户端多用 mcpServers.env */
  rootKey: "mcp" | "mcpServers";
  envKey: "environment" | "env";
}

function nodeModule<T>(name: string): T | null {
  try {
    return require(name) as T;
  } catch (error) {
    return null;
  }
}

interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  writeFileSync(path: string, data: string, encoding: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): unknown;
}

interface OsModule {
  homedir(): string;
}

/** 探测本机已存在配置文件的智能体客户端。 */
export function detectAgents(): AgentTarget[] {
  const fs = nodeModule<FsModule>("fs");
  const os = nodeModule<OsModule>("os");
  if (!fs || !os) return [];
  const home = os.homedir();
  const appdata = String(process.env.APPDATA ?? "");
  const candidates: AgentTarget[] = [
    { id: "opencode", name: "OpenCode", configPath: `${home}/.config/opencode/opencode.jsonc`, rootKey: "mcp", envKey: "environment" },
    { id: "opencode-home", name: "OpenCode (用户目录)", configPath: `${home}/.opencode.json`, rootKey: "mcp", envKey: "environment" },
    { id: "qoder", name: "Qoder", configPath: `${home}/.qoder/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "qoder-cn", name: "Qoder CN", configPath: `${home}/.qoder-cn/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "claude-desktop", name: "Claude Desktop", configPath: `${appdata}/Claude/claude_desktop_config.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "cursor", name: "Cursor", configPath: `${home}/.cursor/mcp.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "cline", name: "Cline", configPath: `${home}/.cline/mcp_settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "gemini", name: "Gemini CLI", configPath: `${home}/.gemini/settings.json`, rootKey: "mcpServers", envKey: "env" },
    { id: "windsurf", name: "Windsurf", configPath: `${home}/.codeium/windsurf/mcp_config.json`, rootKey: "mcpServers", envKey: "env" },
  ];
  return candidates.filter((target) => fs.existsSync(target.configPath));
}

function stripComments(raw: string): string {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
}

function readJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return JSON.parse(stripComments(raw)) as Record<string, unknown>;
  }
}

/** 该客户端是否已经写入过 Sediment 配置。 */
export function isAgentConfigured(target: AgentTarget): boolean {
  const fs = nodeModule<FsModule>("fs");
  if (!fs || !fs.existsSync(target.configPath)) return false;
  try {
    const data = readJson(fs.readFileSync(target.configPath, "utf8"));
    const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
    return Boolean(root.sediment);
  } catch (error) {
    return false;
  }
}

/** 优先复用配置里已有的桥接路径，否则找插件目录；库内副本始终与嵌入源码保持同步。 */
export function resolveBridgePath(plugin: SedimentPlugin, target?: AgentTarget): string {
  const fs = nodeModule<FsModule>("fs");
  if (!fs) return "";
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
      if (fs.existsSync(vaultBridge) && fs.readFileSync(vaultBridge, "utf8") === BRIDGE_SOURCE) return vaultBridge;
      const sep = Math.max(vaultBridge.lastIndexOf("/"), vaultBridge.lastIndexOf("\\"));
      if (sep > 0) fs.mkdirSync(vaultBridge.slice(0, sep), { recursive: true });
      fs.writeFileSync(vaultBridge, BRIDGE_SOURCE, "utf8");
      return fs.existsSync(vaultBridge) ? vaultBridge : "";
    } catch (error) {
      return "";
    }
  };
  if (target) {
    try {
      const data = readJson(fs.readFileSync(target.configPath, "utf8"));
      const root = (data[target.rootKey] ?? {}) as Record<string, { args?: string[] }>;
      const args = root.sediment?.args ?? [];
      const existing = args.find((arg) => arg.endsWith("index.mjs") && fs.existsSync(arg));
      if (existing) {
        // 引用的正是库内副本时先同步；库外路径属用户自有文件，不覆盖。
        if (vaultBridge && samePath(existing, vaultBridge)) return syncVaultBridge();
        return existing;
      }
    } catch (error) {
      // 沿用默认探测
    }
  }
  return syncVaultBridge();
}

function buildEntry(plugin: SedimentPlugin, target: AgentTarget, bridge: string): Record<string, unknown> {
  const url = `http://127.0.0.1:${plugin.store.settings.agentServerPort}`;
  return {
    command: "node",
    args: [bridge],
    [target.envKey]: {
      SEDIMENT_URL: url,
      SEDIMENT_TOKEN: plugin.store.settings.agentServerToken,
      AGENT_NAME: target.id,
    },
    timeout: 60000,
  };
}

/** 返回可复制的 JSON 片段。 */
export function configSnippet(plugin: SedimentPlugin, id = "opencode"): string {
  const target: AgentTarget = {
    id,
    name: id,
    configPath: "",
    rootKey: id === "opencode" ? "mcp" : "mcpServers",
    envKey: id === "opencode" ? "environment" : "env",
  };
  const bridge = resolveBridgePath(plugin);
  return JSON.stringify({ [target.rootKey]: { sediment: buildEntry(plugin, target, bridge) } }, null, 2);
}

/** 把 Sediment MCP 配置合并进目标客户端配置，写入前备份。 */
export function configureAgent(plugin: SedimentPlugin, target: AgentTarget): void {
  const fs = nodeModule<FsModule>("fs");
  if (!fs) throw new Error("一键配置需要桌面版 Obsidian");
  const bridge = resolveBridgePath(plugin, target);
  if (!bridge) throw new Error("找不到 mcp-server/index.mjs，无法配置");
  const raw = fs.readFileSync(target.configPath, "utf8");
  const data = readJson(raw);
  const root = (data[target.rootKey] ?? {}) as Record<string, unknown>;
  root.sediment = buildEntry(plugin, target, bridge);
  data[target.rootKey] = root;
  fs.writeFileSync(`${target.configPath}.bak`, raw, "utf8");
  fs.writeFileSync(target.configPath, JSON.stringify(data, null, 2), "utf8");
}
