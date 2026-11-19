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
import http from "node:http";
import https from "node:https";

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
        sourcePath: { type: "string", description: "可选：来源笔记路径（关联原生待办）" },
        sourceLine: { type: "number", description: "可选：来源复选框行号" },
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
        category: { type: "string", description: "可选；不填则插件根据标题/正文/标签智能推断；也可填任意自定义分类名" },
        folder: { type: "string", description: "分类下的进一步子目录，可选" },
        tags: { type: "array", items: { type: "string" } },
        agent: { type: "string", description: "来源智能体" },
        source: { type: "string", description: "来源任务 / 对话链接" },
        links: { type: "array", items: { type: "string" }, description: "关联的双链笔记名" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_categories",
    description: "列出知识库分类及各分类下的笔记数。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "patch_note",
    description: "按标题或文本片段局部修改笔记，写入前自动备份；支持 ifMatch 防并发覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "库内相对路径" },
        heading: { type: "string", description: "标题文本，如 ## 决策" },
        find: { type: "string", description: "精确文本片段，与 heading 二选一" },
        content: { type: "string", description: "新内容" },
        mode: { type: "string", description: "replace / append / prepend，默认 replace" },
        operation: {
          type: "string",
          enum: ["append_under_heading", "prepend_under_heading", "replace_block", "update_frontmatter"],
          description: "结构化操作类型，优先于 mode",
        },
        index: { type: "number", description: "匹配到第几个，默认 0" },
        ifMatch: { type: "string", description: "内容版本号，来自写入返回" },
        expectedMtime: { type: "number", description: "可选：读取时的 mtime，冲突返回 409" },
        dryRun: { type: "boolean", description: "只返回 Diff 预览，不写入" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "update_frontmatter",
    description: "单独修改笔记 frontmatter 字段，不动正文。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        updates: { type: "object", description: "要设置的字段，如 { status: \"done\", tags: [\"x\"] }" },
        ifMatch: { type: "string" },
      },
      required: ["path", "updates"],
    },
  },
  {
    name: "claim_agent_task",
    description: "认领一条 #to-agent 速记任务，标记为 agent-in-progress。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "速记 id，来自 get_daily_context 的 agentTasks" } },
      required: ["id"],
    },
  },
  {
    name: "complete_agent_task",
    description: "完成任务，标记为 #agent-done，可关联产出笔记路径。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        resultPath: { type: "string", description: "产出笔记的库内路径，可选" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_agent_changes",
    description: "列出最近 Agent 修改过的笔记、快照 id 与操作信息。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数，默认 20" } },
    },
  },
  {
    name: "revert_agent_change",
    description: "按 snapshotId 一键恢复 Agent 修改前的版本。",
    inputSchema: {
      type: "object",
      properties: { snapshotId: { type: "string" } },
      required: ["snapshotId"],
    },
  },
  {
    name: "list_tasks",
    description: "列出 vault 原生待办：today / overdue / all / agent。",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", description: "today / overdue / all / agent" } },
    },
  },
  {
    name: "complete_task",
    description: "勾选指定笔记中某一行的 - [ ] 待办。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "行号，从 1 开始" },
      },
      required: ["path", "line"],
    },
  },
  {
    name: "delegate_task",
    description: "把一条待办转成带 #to-agent 标签的速记任务。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
      },
      required: ["path", "line"],
    },
  },
  {
    name: "snapshot_tasks",
    description: "按需把遗留待办写入当天日记（不默认执行）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "semantic_search",
    description: "本地语义检索：按意义而非关键词查找笔记，返回相关度、路径和片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言查询" },
        limit: { type: "number", description: "最多返回条数，默认 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_active_context",
    description: "获取当前打开的笔记、选中文本、光标行与光标所在段落。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_note_metadata",
    description: "只读笔记元数据（frontmatter、标签、标题大纲、链接），不返回正文，节省 Token。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "库内相对路径" } },
      required: ["path"],
    },
  },
  {
    name: "get_graph_neighbors",
    description: "1-hop 图谱：出链、反向链接和同标签笔记。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "库内相对路径" },
        types: { type: "string", description: "逗号分隔：outgoing,backlinks,tags，默认全部" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_tool_activity",
    description: "查看 MCP/HTTP 工具调用统计（次数、客户端、最近调用）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_pomodoro",
    description: "查看内置番茄钟状态。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "control_pomodoro",
    description: "控制番茄钟：start / pause / reset / skip / toggle。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "start / pause / reset / skip / toggle" },
      },
      required: ["action"],
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

function request(url, method, payload) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = body
      ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      : {};
    const req = transport.request(url, { method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch (error) { data = raw; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(data?.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function call(path, params = {}, method = "GET") {
  const url = new URL(path, BASE);
  url.searchParams.set("token", TOKEN);
  url.searchParams.set("agent", process.env.AGENT_NAME || "");
  if (method === "POST") return request(url, method, params);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return request(url, method, undefined);
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
      return call("/memo", {
        text: args.text,
        tags: args.tags ?? [],
        sourcePath: args.sourcePath ?? "",
        sourceLine: args.sourceLine ?? 0,
      }, "POST");
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
        category: args.category ?? "",
        folder: args.folder ?? "",
        tags: args.tags ?? [],
        agent: args.agent ?? "",
        source: args.source ?? "",
        links: args.links ?? [],
      }, "POST");
    case "list_categories":
      return call("/categories");
    case "patch_note":
      return call("/patch-note", {
        path: args.path ?? "",
        heading: args.heading ?? "",
        find: args.find ?? "",
        content: args.content ?? "",
        mode: args.mode ?? "replace",
        operation: args.operation ?? "",
        index: args.index ?? 0,
        ifMatch: args.ifMatch ?? "",
        expectedMtime: args.expectedMtime ?? 0,
        dryRun: args.dryRun === true,
      }, "POST");
    case "update_frontmatter":
      return call("/frontmatter", {
        path: args.path ?? "",
        updates: args.updates ?? {},
        ifMatch: args.ifMatch ?? "",
      }, "POST");
    case "claim_agent_task":
      return call("/agent-task/claim", { id: args.id }, "POST");
    case "complete_agent_task":
      return call("/agent-task/complete", { id: args.id, resultPath: args.resultPath ?? "" }, "POST");
    case "list_agent_changes":
      return call("/agent/audit", { limit: args.limit ?? 20 });
    case "revert_agent_change":
      return call("/agent/revert", { snapshotId: args.snapshotId }, "POST");
    case "list_tasks":
      return call("/tasks", { scope: args.scope ?? "all" });
    case "complete_task":
      return call("/tasks/complete", { path: args.path, line: args.line }, "POST");
    case "delegate_task":
      return call("/tasks/delegate", { path: args.path, line: args.line }, "POST");
    case "snapshot_tasks":
      return call("/tasks/snapshot", {}, "POST");
    case "semantic_search":
      return call("/semantic-search", { q: args.query ?? "", limit: args.limit ?? 10 });
    case "get_active_context":
      return call("/active-context");
    case "get_note_metadata":
      return call("/note-metadata", { path: args.path });
    case "get_graph_neighbors":
      return call("/graph", { path: args.path, types: args.types ?? "outgoing,backlinks,tags" });
    case "get_tool_activity":
      return call("/activity");
    case "get_pomodoro":
      return call("/pomodoro");
    case "control_pomodoro":
      return call("/pomodoro", { action: args.action ?? "toggle" }, "POST");
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
          serverInfo: { name: "sediment", version: "0.8.7" },
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
