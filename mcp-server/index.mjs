#!/usr/bin/env node
/**
 * Sediment 的 MCP stdio 桥接。
 * 通过本地 HTTP API 把 Obsidian 库暴露成 Agent 可用的工具。
 *
 * 环境变量：
 *   SEDIMENT_URL   （默认 http://127.0.0.1:27123）
 *   SEDIMENT_TOKEN （必填，插件设置里的访问令牌）
 */

import process from "node:process";

const BASE = process.env.SEDIMENT_URL || "http://127.0.0.1:27123";
const TOKEN = process.env.SEDIMENT_TOKEN || "";

const TOOLS = [
  {
    name: "search_notes",
    description: "全文搜索 Obsidian 笔记，返回命中片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "最多返回条数，默认 10" },
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
        folder: { type: "string", description: "文件夹路径，留空表示整个库" },
        limit: { type: "number", description: "最多返回条数，默认 50" },
      },
    },
  },
  {
    name: "read_note",
    description: "读取指定路径笔记的全文。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "库内相对路径，如 daily/2026-11-19.md" } },
      required: ["path"],
    },
  },
  {
    name: "create_note",
    description: "新建笔记；若已存在会报错。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "库内相对路径，需以 .md 结尾" },
        content: { type: "string", description: "Markdown 正文" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_note",
    description: "向已有笔记末尾追加内容。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "add_memo",
    description: "记一条速记，写入当天日记的速记段落。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "速记内容" },
        tags: { type: "array", items: { type: "string" }, description: "标签" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_stats",
    description: "获取最近若干天的写作与贡献统计。",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "天数，默认 30" } },
    },
  },
  {
    name: "get_today",
    description: "获取今日快照（贡献分、连续天数、速记积压等）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_memos",
    description: "获取最近的速记列表。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数，默认 20" } },
    },
  },
  {
    name: "get_backlog",
    description: "获取尚未转化的速记数量。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "generate_weekly_review",
    description: "按日期生成周复盘 Markdown，不落盘。",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD，留空为本周" } },
    },
  },
  {
    name: "get_daily_context",
    description: "智能体开工时拉取上下文包：今日状态、最近工作日志、速记和笔记。",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "回溯天数，默认 7" } },
    },
  },
  {
    name: "record_work_log",
    description: "把本次智能体工作沉淀成日志：任务、完成、决策、涉及文件、学到的东西和待确认事项。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "智能体名称，如 opencode / qoder" },
        task: { type: "string", description: "本次任务" },
        summary: { type: "string", description: "完成了什么" },
        decisions: { type: "string", description: "做出的决策与理由" },
        files: { type: "array", items: { type: "string" }, description: "涉及的文件路径" },
        learnings: { type: "string", description: "学到的东西 / 可复用的结论" },
        openQuestions: { type: "string", description: "未决问题或下一步" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["task", "summary"],
    },
  },
  {
    name: "add_knowledge",
    description: "把一条知识写成带 frontmatter 的独立 Markdown 笔记，长期沉淀到知识库。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题" },
        content: { type: "string", description: "Markdown 正文" },
        folder: { type: "string", description: "knowledge 下的子目录，可选" },
        tags: { type: "array", items: { type: "string" } },
        agent: { type: "string", description: "来源智能体" },
        source: { type: "string", description: "来源任务 / 对话链接" },
        links: { type: "array", items: { type: "string" }, description: "关联的双链笔记名" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_work_logs",
    description: "列出最近 N 天所有智能体工作日志。",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "天数，默认 7" } },
    },
  },
];

async function call(path, params = {}, method = "GET") {
  const url = new URL(path, BASE);
  url.searchParams.set("token", TOKEN);
  const init = { method, headers: {} };
  if (method === "POST") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(params);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = text;
  }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function dispatch(name, args) {
  switch (name) {
    case "search_notes":
      return call("/search", { q: args.query ?? "", limit: args.limit ?? 10 });
    case "list_notes":
      return call("/notes", { folder: args.folder ?? "", limit: args.limit ?? 50 });
    case "read_note":
      return call("/note", { path: args.path });
    case "create_note":
      return call("/note", { path: args.path, content: args.content, mode: "create" }, "POST");
    case "append_note":
      return call("/note", { path: args.path, content: args.content, mode: "append" }, "POST");
    case "add_memo":
      return call("/memo", { text: args.text, tags: args.tags ?? [] }, "POST");
    case "get_stats":
      return call("/stats", { days: args.days ?? 30 });
    case "get_today":
      return call("/today");
    case "get_memos":
      return call("/memos", { limit: args.limit ?? 20 });
    case "get_backlog":
      return call("/backlog");
    case "generate_weekly_review":
      return call("/review", { date: args.date ?? "" });
    case "get_daily_context":
      return call("/context", { days: args.days ?? 7 });
    case "record_work_log":
      return call("/worklog", {
        agent: args.agent ?? "",
        task: args.task ?? "",
        summary: args.summary ?? "",
        decisions: args.decisions ?? "",
        learnings: args.learnings ?? "",
        openQuestions: args.openQuestions ?? "",
        files: args.files ?? [],
        tags: args.tags ?? [],
      }, "POST");
    case "add_knowledge":
      return call("/knowledge", {
        title: args.title ?? "",
        content: args.content ?? "",
        folder: args.folder ?? "",
        tags: args.tags ?? [],
        agent: args.agent ?? "",
        source: args.source ?? "",
        links: args.links ?? [],
      }, "POST");
    case "list_work_logs":
      return call("/worklogs", { days: args.days ?? 7 });
    default:
      throw new Error(`未知工具：${name}`);
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
          serverInfo: { name: "sediment", version: "0.1.3" },
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
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      // 忽略非法 JSON 行
    }
  }
});
