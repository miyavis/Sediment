import { spawnSync } from "node:child_process";

const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  "",
].join("\n");

const result = spawnSync(process.execPath, ["mcp-server/index.mjs"], {
  input,
  encoding: "utf8",
});
if (result.status !== 0) {
  console.error(result.stderr || "mcp bridge failed");
  process.exit(1);
}

const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
const init = messages.find((message) => message.id === 1);
const list = messages.find((message) => message.id === 2);
if (!init?.result || !list?.result?.tools) {
  console.error("MCP handshake failed:", result.stdout);
  process.exit(1);
}

console.log(`MCP OK — ${list.result.tools.length} tools:`);
console.log(list.result.tools.map((tool) => `  - ${tool.name}`).join("\n"));
