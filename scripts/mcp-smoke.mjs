import { spawnSync } from "node:child_process";

const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 4, method: "unknown/method", params: {} }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "read_note", arguments: {} },
  }),
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
const ping = messages.find((message) => message.id === 3);
const unknown = messages.find((message) => message.id === 4);
const missingArgument = messages.find((message) => message.id === 5);
if (!init?.result || !list?.result?.tools) {
  console.error("MCP handshake failed:", result.stdout);
  process.exit(1);
}
if (!ping?.result || unknown?.error?.code !== -32601) {
  console.error("MCP lifecycle smoke failed:", result.stdout);
  process.exit(1);
}

const requiredTools = [
  "get_daily_context",
  "get_active_context",
  "search_notes",
  "list_notes",
  "read_note",
  "write_note",
  "patch_note",
  "add_memo",
  "add_knowledge",
  "record_work_log",
  "manage_tasks",
  "manage_changes",
  "get_workspace_state",
];
const names = new Set(list.result.tools.map((tool) => tool.name));
const missingTools = requiredTools.filter((name) => !names.has(name));
if (missingTools.length > 0) {
  console.error(`MCP tool inventory missing: ${missingTools.join(", ")}`);
  process.exit(1);
}
if (list.result.tools.length !== 13) {
  console.error(`MCP public tool count expected 13, got ${list.result.tools.length}`);
  process.exit(1);
}
const removedTools = [
  "create_note",
  "append_note",
  "list_agent_changes",
  "revert_agent_change",
  "claim_agent_task",
  "complete_agent_task",
];
const unexpectedlyPresent = removedTools.filter((name) => names.has(name));
if (unexpectedlyPresent.length > 0) {
  console.error(`Removed MCP tools still exposed: ${unexpectedlyPresent.join(", ")}`);
  process.exit(1);
}
if (!missingArgument?.result?.isError || !missingArgument.result.content?.[0]?.text?.includes("缺少必填参数")) {
  console.error("MCP required-argument validation failed:", result.stdout);
  process.exit(1);
}

console.log(`MCP OK — ${list.result.tools.length} tools:`);
console.log(list.result.tools.map((tool) => `  - ${tool.name}`).join("\n"));
