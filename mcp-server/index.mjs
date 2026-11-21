#!/usr/bin/env node
/**
 * Sediment MCP stdio bridge.
 * 暴露任务型工具和只读工作区聚合入口；旧细粒度工具名不再保留。
 */

import process from "node:process";
import http from "node:http";
import https from "node:https";

const BASE = process.env.SEDIMENT_URL || "http://127.0.0.1:27123";
const TOKEN = process.env.SEDIMENT_TOKEN || "";

/** HTTP 请求超时与响应体/stdin 缓冲上限，防止挂死与无界内存增长。 */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const MAX_STDIN_BUFFER_CHARS = 1024 * 1024;

const TOOLS = [
  {
    name: "get_daily_context",
    description: "获取今日状态、最近工作日志、速记、笔记和 Agent 待办。",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "回溯天数，默认 7" } } },
  },
  {
    name: "get_active_context",
    description: "获取当前笔记、选中文本、光标行和光标段落。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_notes",
    description: "全文或本地语义检索笔记。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "最多返回条数，默认 10" },
        mode: { type: "string", enum: ["text", "semantic"], description: "默认 text" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_notes",
    description: "列出笔记，可按文件夹过滤。",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string" },
        limit: { type: "number", description: "最多返回条数，默认 50" },
      },
    },
  },
  {
    name: "read_note",
    description: "读取指定笔记全文或只读元数据。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        metadataOnly: { type: "boolean", description: "只返回 frontmatter、标签、标题大纲和链接" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_note",
    description: "统一写入笔记：create、append 或 overwrite。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        action: { type: "string", enum: ["create", "append", "overwrite"], description: "默认 create" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch_note",
    description: "按标题或文本片段局部修改，支持预览、版本冲突和快照。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        heading: { type: "string" },
        find: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["replace", "append", "prepend"] },
        operation: {
          type: "string",
          enum: ["append_under_heading", "prepend_under_heading", "replace_block", "update_frontmatter"],
        },
        index: { type: "number" },
        ifMatch: { type: "string" },
        expectedMtime: { type: "number" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "add_memo",
    description: "记一条速记，可关联待办来源。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        sourcePath: { type: "string" },
        sourceLine: { type: "number" },
      },
      required: ["text"],
    },
  },
  {
    name: "add_knowledge",
    description: "沉淀知识笔记、分类、标签和关联来源。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        category: { type: "string" },
        folder: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        agent: { type: "string" },
        source: { type: "string" },
        links: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "record_work_log",
    description: "记录 Agent 工作日志、决策、涉及文件、学习和待确认事项。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        decisions: { type: "string" },
        learnings: { type: "string" },
        openQuestions: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["task", "summary"],
    },
  },
  {
    name: "manage_tasks",
    description: "统一管理任务：list、complete、delegate、snapshot、claim 或 complete_agent。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "complete", "delegate", "snapshot", "claim", "complete_agent"] },
        scope: { type: "string", enum: ["today", "overdue", "all", "agent"] },
        id: { type: "string" },
        path: { type: "string" },
        line: { type: "number" },
        resultPath: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "get_workspace_state",
    description: "按需聚合只读高级状态：统计、图谱、番茄钟、周复盘、调用活动、工作日志或分类。",
    inputSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            type: "string",
            enum: ["stats", "graph", "pomodoro", "weekly_review", "tool_activity", "work_logs", "categories"],
          },
          description: "留空时返回 today、stats、pomodoro、work_logs、categories 和 tool_activity",
        },
        path: { type: "string", description: "graph section 使用的笔记路径" },
        types: { type: "string", description: "graph 类型，默认 outgoing,backlinks,tags" },
        days: { type: "number", description: "stats/work_logs 回溯天数" },
        date: { type: "string", description: "weekly_review 锚定日期 YYYY-MM-DD" },
        limit: { type: "number", description: "tool_activity 或 work_logs 数量上限" },
      },
    },
  },
  {
    name: "manage_changes",
    description: "统一审查 Agent 修改：list 或 revert。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "revert"] },
        snapshotId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["action"],
    },
  },
];

function request(url, method, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...extraHeaders };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = transport.request(url, { method, headers }, (res) => {
      let raw = "";
      let oversized = false;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > MAX_RESPONSE_CHARS) {
          oversized = true;
          req.destroy(new Error(`响应体过大（上限 ${MAX_RESPONSE_CHARS} 字符）`));
        }
      });
      res.on("end", () => {
        if (oversized) return;
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(data?.error || `HTTP ${res.statusCode}`));
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${url.pathname}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function call(path, params = {}, method = "GET") {
  // 令牌缺失与令牌错误分开提示：缺失是配置问题，401 才是令牌不匹配。
  if (!TOKEN) {
    throw new Error("缺少令牌：请设置 SEDIMENT_TOKEN 环境变量（插件设置 → Agent 接入可复制）");
  }
  const url = new URL(path, BASE);
  url.searchParams.set("agent", process.env.AGENT_NAME || "");
  // 令牌只走 Authorization 头，不再放查询串（会落入日志/代理缓存）。
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (method === "POST") return request(url, method, params, headers);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return request(url, method, undefined, headers);
}

async function dispatch(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未知工具：${name}`);
  const missing = (tool.inputSchema.required ?? []).filter(
    (key) => args[key] === undefined || args[key] === null || args[key] === ""
  );
  if (missing.length > 0) throw new Error(`缺少必填参数：${missing.join(", ")}`);

  switch (name) {
    case "get_daily_context":
      return call("/context", { days: args.days ?? 7 });
    case "get_active_context":
      return call("/active-context");
    case "search_notes":
      return call(args.mode === "semantic" ? "/semantic-search" : "/search", {
        q: args.query ?? "",
        query: args.query ?? "",
        limit: args.limit ?? 10,
      });
    case "list_notes":
      return call("/notes", { folder: args.folder ?? "", limit: args.limit ?? 50 });
    case "read_note":
      return args.metadataOnly
        ? call("/note-metadata", { path: args.path })
        : call("/note", { path: args.path });
    case "write_note":
      return call("/note", { path: args.path, content: args.content, mode: args.action ?? "create" }, "POST");
    case "patch_note":
      return call("/patch-note", {
        path: args.path,
        heading: args.heading ?? "",
        find: args.find ?? "",
        content: args.content,
        mode: args.mode ?? "replace",
        operation: args.operation ?? "",
        index: args.index,
        ifMatch: args.ifMatch ?? "",
        expectedMtime: args.expectedMtime,
        dryRun: args.dryRun === true,
      }, "POST");
    case "add_memo":
      return call("/memo", {
        text: args.text,
        tags: args.tags ?? [],
        sourcePath: args.sourcePath ?? "",
        sourceLine: args.sourceLine ?? 0,
      }, "POST");
    case "add_knowledge":
      return call("/knowledge", {
        title: args.title,
        content: args.content,
        category: args.category ?? "",
        folder: args.folder ?? "",
        tags: args.tags ?? [],
        agent: args.agent ?? "",
        source: args.source ?? "",
        links: args.links ?? [],
      }, "POST");
    case "record_work_log":
      return call("/worklog", {
        agent: args.agent ?? "",
        task: args.task,
        summary: args.summary,
        decisions: args.decisions ?? "",
        learnings: args.learnings ?? "",
        openQuestions: args.openQuestions ?? "",
        files: args.files ?? [],
        tags: args.tags ?? [],
      }, "POST");
    case "manage_tasks":
      switch (args.action) {
        case "list": return call("/tasks", { scope: args.scope ?? "all" });
        case "complete": return call("/tasks/complete", { path: args.path, line: args.line }, "POST");
        case "delegate": return call("/tasks/delegate", { path: args.path, line: args.line }, "POST");
        case "snapshot": return call("/tasks/snapshot", {}, "POST");
        case "claim": return call("/agent-task/claim", { id: args.id }, "POST");
        case "complete_agent":
          return call("/agent-task/complete", { id: args.id, resultPath: args.resultPath ?? "" }, "POST");
      }
      throw new Error("manage_tasks.action 无效");
    case "get_workspace_state":
      {
        const allowed = new Set(["stats", "graph", "pomodoro", "weekly_review", "tool_activity", "work_logs", "categories"]);
        const requested = Array.isArray(args.sections)
          ? args.sections.filter((section) => allowed.has(section))
          : ["stats", "pomodoro", "tool_activity", "work_logs", "categories"];
        const sections = [...new Set(requested)];
        const state = {};
        const reads = [];

        if (sections.includes("stats")) {
          reads.push(call("/stats", { days: args.days ?? 30 }).then((value) => { state.stats = value; }));
        }
        if (sections.includes("graph")) {
          if (!args.path) {
            state.graph = { skipped: true, reason: "graph 需要 path 参数" };
          } else {
            reads.push(call("/graph", { path: args.path, types: args.types ?? "outgoing,backlinks,tags" })
              .then((value) => { state.graph = value; }));
          }
        }
        if (sections.includes("pomodoro")) {
          reads.push(call("/pomodoro").then((value) => { state.pomodoro = value; }));
        }
        if (sections.includes("weekly_review")) {
          reads.push(call("/review", { date: args.date ?? "" })
            .then((value) => { state.weeklyReview = value; }));
        }
        if (sections.includes("tool_activity")) {
          reads.push(call("/activity").then((value) => { state.toolActivity = value; }));
        }
        if (sections.includes("work_logs")) {
          reads.push(call("/worklogs", { days: args.days ?? 7 })
            .then((value) => { state.workLogs = value; }));
        }
        if (sections.includes("categories")) {
          reads.push(call("/categories").then((value) => { state.categories = value; }));
        }

        await Promise.all(reads);
        return state;
      }
    case "manage_changes":
      if (args.action === "list") return call("/agent/audit", { limit: args.limit ?? 20 });
      if (args.action === "revert") return call("/agent/revert", { snapshotId: args.snapshotId }, "POST");
      throw new Error("manage_changes.action 无效");
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(message) {
  if (message.id === undefined) return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sediment", version: "1.0.11" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      try {
        const data = await dispatch(params?.name, params?.arguments ?? {});
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
          },
        });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true },
        });
      }
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > MAX_STDIN_BUFFER_CHARS) {
    process.stderr.write("sediment-mcp: stdin 缓冲超过 1MB 上限，断开连接\n");
    process.exit(1);
  }
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      // 畸形 JSON 说明流已不可信：记诊断（stderr）后断开，不再静默吞掉。
      process.stderr.write(`sediment-mcp: 畸形 JSON 输入，断开连接：${error.message}\n`);
      process.exit(1);
    }
    void handle(message);
  }
});
