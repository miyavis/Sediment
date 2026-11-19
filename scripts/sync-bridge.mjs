import fs from "node:fs";

// 把 MCP 桥接源码嵌入插件 bundle：Obsidian 只安装三件套，
// 一键配置时若库内缺 mcp-server/index.mjs，由 setup.ts 用这份源码落盘。
const source = "mcp-server/index.mjs";
const target = "src/agent/bridge-source.ts";
const code = fs.readFileSync(source, "utf8");
const output = `// 由 scripts/sync-bridge.mjs 从 mcp-server/index.mjs 自动生成，请勿手动修改。
export const BRIDGE_SOURCE = ${JSON.stringify(code)};
`;
fs.writeFileSync(target, output, "utf8");
console.log(`synced ${source} -> ${target} (${code.length} chars)`);