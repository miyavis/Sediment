import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice, TFile, type Plugin } from "obsidian";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { configureAgent, configSnippet, isAgentConfigured, resolveBridgePath } from "../src/agent/setup";
import * as setupNs from "../src/agent/setup";
import { BRIDGE_SOURCE } from "../src/agent/bridge-source";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_SETTINGS,
  type DayRecord,
  type FocusSessionRecord,
  type MemoRecord,
  type PendingWriteRecord,
  type PersistedPomodoro,
  type PulseSettings,
} from "../src/types";
import {
  dateKey,
  parseKey,
  addDays,
  startOfWeek,
  endOfWeek,
  lastNDays,
  eachDay,
  formatDailyNoteName,
  dailyNotePath,
  hhmm,
  localHHmm,
  localStamp,
  isSameLocalDay,
} from "../src/utils/dates";
import { countWords, countCheckedTasks, noteDateKey, Tracker } from "../src/tracking/tracker";
import { PomodoroManager } from "../src/features/pomodoro";
import { MemoManager } from "../src/features/memo";
import { buildWeeklyReview } from "../src/features/review";
import SedimentPlugin from "../src/main";
import { normalizeFolder } from "../src/utils/vault";
import { TaskManager } from "../src/features/tasks";
import { buildStatsCsv, buildExportJson, DEFAULT_EXPORT_OPTIONS } from "../src/features/export";
import { todayLine } from "../src/features/embed";
import { Store } from "../src/data/store";
import { AgentApi, ApiError, safeAgentPath } from "../src/agent/api";
import { reconcilePendingWrites, markStaleByPaths } from "../src/agent/reconcile";
import { SemanticIndex, tokenizeSemanticText } from "../src/agent/semantic";
import { AgentServer, sanitizeServerError, tokensMatch } from "../src/agent/server";
import { idempotencyKey, redactAuditPath, redactSecrets } from "../src/agent/security";
import { computeDiff } from "../src/ui/diff-modal";
import { barChart, escapeAttr, goalRing, mean, multiLine, referenceLines, ring, sparkline } from "../src/utils/charts";
import { aggregateStrata, listMonths, recentStrataRange } from "../src/utils/strata";
import { logError } from "../src/utils/log-error";
import { getLocale, localeFromPersisted, setLocale, t, tf } from "../src/i18n";
import { findViolations, stripComments } from "../scripts/lint-i18n.mjs";
import {
  inferCategory,
  isOperationAllowed,
  isPathAllowedByMode,
  isPathDenied,
  isSafePathSegmentName,
  listCategories,
  splitList,
} from "../src/agent/access";
import {
  filterAgentTasks,
  pendingReviewChanges,
  reviewBadgeCount,
} from "../src/views/dashboard/review-queue";
import { SETTINGS_SECTIONS, settingsSection } from "../src/ui/settings-sections";
import { renderYearly } from "../src/views/dashboard/sections/insights";
import { scanKnowledgeState, type KnowledgeFile } from "../src/features/knowledge-state";

const day = (partial: Partial<DayRecord> = {}): DayRecord => ({ ...createEmptyDay(), ...partial });
const settings = (partial: Partial<PulseSettings> = {}): PulseSettings => ({
  ...DEFAULT_SETTINGS,
  ...partial,
});

test("computeContribution：默认权重下分项之和等于总分", () => {
  const d = day({ notesCreated: 1, edits: 1, tasksCompleted: 1, wordsAdded: 100, focusMinutes: 25 });
  // 2 + 1 + 1 + floor(100/100)=1 + floor(25/25)=1 = 6
  assert.equal(computeContribution(d, settings({ contributionDailyCap: 0 })), 6);
});

test("computeContribution：词数与专注分钟向下取整", () => {
  const d = day({ wordsAdded: 150, focusMinutes: 49 });
  // floor(150/100)=1 + floor(49/25)=1 = 2
  assert.equal(computeContribution(d, settings({ contributionDailyCap: 0 })), 2);
});

test("computeContribution：单日封顶截断", () => {
  const d = day({ notesCreated: 100, wordsAdded: 100000 });
  assert.equal(computeContribution(d, settings({ contributionDailyCap: 120 })), 120);
});

test("computeContribution：封顶为 0 表示不封顶", () => {
  const d = day({ notesCreated: 100 });
  assert.equal(computeContribution(d, settings({ contributionDailyCap: 0 })), 200);
});

test("computeContribution：自定义权重生效", () => {
  const d = day({ notesCreated: 2, edits: 3, tasksCompleted: 4, wordsAdded: 200, focusMinutes: 50 });
  const s = settings({
    contributionDailyCap: 0,
    weightNotesCreated: 5,
    weightEdits: 2,
    weightTasks: 3,
    wordsPerPoint: 50,
    focusMinutesPerPoint: 10,
  });
  // 2*5 + 3*2 + 4*3 + floor(200/50)=4 + floor(50/10)=5 = 10+6+12+4+5 = 37
  assert.equal(computeContribution(d, s), 37);
});

test("computeContribution：空白天得 0 分", () => {
  assert.equal(computeContribution(createEmptyDay(), DEFAULT_SETTINGS), 0);
});

test("dates：dateKey 补零", () => {
  assert.equal(dateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(dateKey(new Date(2026, 10, 19)), "2026-11-19");
});

test("dates：parseKey 与 dateKey 往返一致", () => {
  const key = "2026-03-09";
  assert.equal(dateKey(parseKey(key)), key);
});

test("dates：addDays 跨月边界", () => {
  assert.equal(dateKey(addDays(new Date(2026, 0, 31), 1)), "2026-02-01");
  assert.equal(dateKey(addDays(new Date(2026, 11, 31), 1)), "2027-01-01");
});

test("dates：startOfWeek 落在指定起始日且不晚于当天", () => {
  const d = new Date(2026, 10, 19);
  for (const weekStart of [0, 1] as const) {
    const start = startOfWeek(d, weekStart);
    assert.equal(start.getDay(), weekStart);
    assert.ok(start.getTime() <= d.getTime());
    assert.ok(d.getTime() - start.getTime() < 7 * 86400000);
    assert.equal(dateKey(endOfWeek(d, weekStart)), dateKey(addDays(start, 6)));
  }
});

test("dates：lastNDays 长度与从早到晚顺序", () => {
  const keys = lastNDays(7, new Date(2026, 10, 19));
  assert.equal(keys.length, 7);
  assert.equal(keys[6], "2026-11-19");
  assert.equal(keys[0], "2026-11-13");
  assert.deepEqual([...keys].sort(), keys);
});

test("dates：eachDay 含两端", () => {
  const keys = eachDay(new Date(2026, 0, 1), new Date(2026, 0, 3));
  assert.deepEqual(keys, ["2026-01-01", "2026-01-02", "2026-01-03"]);
});

test("dates：formatDailyNoteName 替换占位符", () => {
  assert.equal(formatDailyNoteName("YYYY/MM/DD", new Date(2026, 0, 5)), "2026/01/05");
});

test("dates：hhmm 补零", () => {
  assert.equal(hhmm(new Date(2026, 0, 1, 9, 5)), "09:05");
});

test("dates：localHHmm/localStamp 把 UTC 时间转成本地时间", () => {
  const d = new Date(2026, 0, 1, 9, 5, 7);
  const iso = d.toISOString();
  assert.equal(localHHmm(iso), "09:05");
  assert.equal(localStamp(iso), "2026-01-01 09:05");
  assert.equal(localStamp(iso, true), "2026-01-01 09:05:07");
});

test("dates：isSameLocalDay 按本地日期判定", () => {
  const d = new Date(2026, 0, 1, 0, 30);
  assert.equal(isSameLocalDay(d.toISOString(), "2026-01-01"), true);
  assert.equal(isSameLocalDay(d.toISOString(), "2026-01-02"), false);
});

test("charts：mean 空数组返回 0，正常求均值", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4, 6]), 4);
});

test("charts：barChart 生成 SVG 且按值数量画柱", () => {
  const svg = barChart([1, 2, 3]);
  assert.match(svg, /<svg class="sd-chart"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 3);
});

test("charts：referenceLines 过滤 value<=0 并输出标签", () => {
  const svg = referenceLines([{ value: 5, label: "均值" }, { value: 0, label: "隐藏" }], 10, 100, 50, 5);
  assert.match(svg, /均值/);
  assert.doesNotMatch(svg, /隐藏/);
});

test("charts：ring 按 active/total 输出比例", () => {
  assert.match(ring(3, 4), /class="sd-ring"/);
  assert.match(ring(3, 4), />3</);
});

const accessSettings = {
  deniedFolders: "私有,归档/secret",
  deniedTags: "",
  agentAccessMode: "allow-all" as const,
  agentAllowedFolders: " ",
  agentAllowRead: true,
  agentAllowCreate: true,
  agentAllowPatch: false,
  agentAllowOverwrite: false,
  agentAllowDelete: false,
};

test("access：isPathDenied 命中目录及子路径", () => {
  assert.equal(isPathDenied("私有", "私有,归档/secret"), true);
  assert.equal(isPathDenied("私有/日记.md", "私有,归档/secret"), true);
  assert.equal(isPathDenied("公开", "私有,归档/secret"), false);
});

test("access：isOperationAllowed 按设置判定", () => {
  assert.equal(isOperationAllowed("read", accessSettings), true);
  assert.equal(isOperationAllowed("patch", accessSettings), false);
});

test("access：allowlist 模式只放行白名单目录", () => {
  const allowlist = {
    ...accessSettings,
    agentAccessMode: "allowlist" as const,
    agentAllowedFolders: "知识,日记",
  };
  assert.equal(isPathAllowedByMode("知识/a.md", allowlist), true);
  assert.equal(isPathAllowedByMode("其他/a.md", allowlist), false);
  assert.equal(isPathAllowedByMode("私有/a.md", allowlist), false);
});

test("access：listCategories 与 inferCategory", () => {
  assert.deepEqual(listCategories("技术, 项目,,灵感"), ["技术", "项目", "灵感"]);
  assert.equal(inferCategory("周报", "", [], ["技术", "项目"]), "复盘");
  assert.equal(inferCategory("随手记", "", [], ["灵感"]), "灵感");
});

test("countWords：中文按字计", () => {
  assert.equal(countWords("你好世界"), 4);
});

test("countWords：英文按词计", () => {
  assert.equal(countWords("hello world foo"), 3);
});

test("countWords：中英混合分别计数", () => {
  // 你好世界 = 4 字，hello = 1 词
  assert.equal(countWords("你好 hello 世界"), 5);
});

test("countWords：空串为 0", () => {
  assert.equal(countWords(""), 0);
});

test("countCheckedTasks：只数已勾选的待办", () => {
  const text = "- [x] done\n- [ ] todo\n* [X] done2\n+ [ ] todo2\n普通文本";
  assert.equal(countCheckedTasks(text), 2);
});

test("noteDateKey：优先 frontmatter created", () => {
  const text = "---\ncreated: 2020-05-01\ntags: [a]\n---\n正文";
  assert.equal(noteDateKey(text, new Date(2026, 10, 19)), "2020-05-01");
});

test("noteDateKey：date 字段亦可", () => {
  const text = "---\ndate: 2019-12-31\n---\n正文";
  assert.equal(noteDateKey(text, new Date(2026, 10, 19)), "2019-12-31");
});

test("noteDateKey：非法日期回退创建时间", () => {
  const text = "---\ncreated: 2026-13-40\n---\n正文";
  assert.equal(noteDateKey(text, new Date(2026, 10, 19)), "2026-11-19");
});

test("noteDateKey：无 frontmatter 回退创建时间", () => {
  assert.equal(noteDateKey("没有 frontmatter", new Date(2026, 10, 19)), "2026-11-19");
});

test("normalizeFolder：去掉首尾与重复斜杠", () => {
  assert.equal(normalizeFolder("/a/b/"), "a/b");
  assert.equal(normalizeFolder("a//b"), "a/b");
  assert.equal(normalizeFolder(""), "");
});

/** 构造一个仅含导出所需字段的假 Store。 */
function fakeStore(): Store {
  const days = { "2026-11-19": day({ contribution: 6, wordsAdded: 100, aiWordsAdded: 20 }) };
  const data = {
    days,
    memos: [
      {
        id: "m1", date: "2026-11-19", time: "09:00", text: "私密正文", tags: ["a"],
        converted: false, archived: false, sourcePath: "daily/secret.md", sourceLine: 3, resultPath: "out.md",
      },
    ],
    workLogs: [
      {
        id: "w1", date: "2026-11-19", time: "09:00", agent: "qoder", task: "t", summary: "s",
        decisions: "d", learnings: "l", openQuestions: "q", tags: [], files: ["private/x.md"],
      },
    ],
    focusSessions: [],
    settings: settings({ agentServerToken: "SUPER-SECRET-TOKEN" }),
  };
  return {
    data,
    settings: data.settings,
    getDay: (key: string) => days[key] ?? createEmptyDay(),
  } as unknown as Store;
}

test("export：默认脱敏不含正文/路径/令牌", () => {
  const json = buildExportJson(fakeStore(), { ...DEFAULT_EXPORT_OPTIONS });
  assert.ok(!json.includes("私密正文"));
  assert.ok(!json.includes("daily/secret.md"));
  assert.ok(!json.includes("private/x.md"));
  assert.ok(!json.includes("SUPER-SECRET-TOKEN"));
  const parsed = JSON.parse(json);
  assert.equal(parsed.sanitization.memoText, "removed");
  assert.equal(parsed.sanitization.paths, "removed");
  assert.equal(parsed.sanitization.secrets, "never-exported");
  assert.equal(parsed.memos[0].text, undefined);
});

test("export：勾选后才包含正文与路径", () => {
  const json = buildExportJson(fakeStore(), { format: "json", includeMemoText: true, includePaths: true });
  const parsed = JSON.parse(json);
  assert.equal(parsed.memos[0].text, "私密正文");
  assert.equal(parsed.memos[0].sourcePath, "daily/secret.md");
  assert.deepEqual(parsed.workLogs[0].files, ["private/x.md"]);
  assert.ok(!json.includes("SUPER-SECRET-TOKEN"));
});

test("export：CSV 含表头与按日聚合行", () => {
  const csv = buildStatsCsv(fakeStore());
  const lines = csv.split("\n");
  assert.ok(lines[0].startsWith("date,contribution,wordsAdded"));
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("2026-11-19,6,100"));
});

test("桥接版本与 manifest 一致（不再硬编码旧版本）", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8")) as { version: string };
  assert.ok(
    BRIDGE_SOURCE.includes(`version: "${manifest.version}"`),
    `桥接源码应含版本 ${manifest.version}`
  );
});

test("resolveBridgePath：库内缺失时自动落盘嵌入式桥接并可握手", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-bridge-"));
  try {
    const fakePlugin = {
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: { getFullPath: (p: string) => path.join(tmp, p) },
        },
      },
    };
    const bridge = resolveBridgePath(fakePlugin as unknown as Parameters<typeof resolveBridgePath>[0]);
    assert.ok(bridge.length > 0, "应返回桥接路径");
    assert.ok(fs.existsSync(bridge), "返回的路径必须真实存在");
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    });
    const res = spawnSync(process.execPath, [bridge], {
      input: init + "\n",
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(res.status, 0, `桥接进程应正常退出：${res.stderr}`);
    const reply = JSON.parse(res.stdout.trim().split("\n")[0]);
    assert.equal(reply.result.serverInfo.name, "sediment");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveBridgePath：库内旧版桥接被刷新为嵌入源码（协议升级自愈）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-bridge-stale-"));
  try {
    const fakePlugin = {
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: { getFullPath: (p: string) => path.join(tmp, p) },
        },
      },
    };
    const asPlugin = fakePlugin as unknown as Parameters<typeof resolveBridgePath>[0];
    const vaultBridge = path.join(tmp, ".obsidian", "plugins", "sediment", "mcp-server", "index.mjs");
    fs.mkdirSync(path.dirname(vaultBridge), { recursive: true });
    const stale = '// 旧版桥接：url.searchParams.set("token", TOKEN)\n';
    fs.writeFileSync(vaultBridge, stale, "utf8");
    // 场景 1：无 target，库内已有旧桥接 → 必须刷新而不是原样复用
    const bridge = resolveBridgePath(asPlugin);
    assert.equal(bridge, vaultBridge);
    assert.equal(fs.readFileSync(vaultBridge, "utf8"), BRIDGE_SOURCE, "库内旧桥接应被重写为嵌入源码");
    // 场景 2：客户端配置已引用库内桥接（正斜杠写法）→ 同样刷新
    fs.writeFileSync(vaultBridge, stale, "utf8");
    const cfgPath = path.join(tmp, "client.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcpServers: { sediment: { command: "node", args: [vaultBridge.replace(/\\/g, "/")] } } }),
      "utf8"
    );
    const target = { id: "x", name: "X", configPath: cfgPath, rootKey: "mcpServers" as const, envKey: "env" as const };
    const bridge2 = resolveBridgePath(asPlugin, target);
    assert.ok(bridge2.length > 0);
    assert.equal(fs.readFileSync(vaultBridge, "utf8"), BRIDGE_SOURCE, "配置引用的库内旧桥接也应被刷新");
    // 场景 3：配置引用库外路径（用户自有文件）→ 复用且不覆盖
    const external = path.join(tmp, "elsewhere", "index.mjs");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.writeFileSync(external, "// user-managed bridge\n", "utf8");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcpServers: { sediment: { command: "node", args: [external] } } }),
      "utf8"
    );
    const bridge3 = resolveBridgePath(asPlugin, target);
    assert.equal(bridge3, external);
    assert.equal(fs.readFileSync(external, "utf8"), "// user-managed bridge\n", "库外用户文件不得被覆盖");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- OpenCode v1/v2 一键配置适配 ----------

type LayoutFn = (data: Record<string, unknown>, probe?: () => number | undefined) => "v1" | "v2";
function layoutFn(): LayoutFn {
  const fn = (setupNs as unknown as { detectOpenCodeLayout?: LayoutFn }).detectOpenCodeLayout;
  assert.equal(typeof fn, "function", "setup.ts 应导出 detectOpenCodeLayout");
  return fn as LayoutFn;
}

function fakeSetupPlugin(tmp: string) {
  return {
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: { getFullPath: (p: string) => path.join(tmp, p) },
      },
    },
    store: { settings: { agentServerPort: 27123, agentServerToken: "t".repeat(32) } },
  } as unknown as Parameters<typeof configureAgent>[0];
}

function openCodeTarget(cfgPath: string) {
  return { id: "opencode", name: "OpenCode", configPath: cfgPath, rootKey: "mcp" as const, envKey: "environment" as const };
}

test("detectOpenCodeLayout：配置形状优先——有 mcp.servers 判 v2，直挂 type/command 数组条目判 v1，形状明确时不探测版本", () => {
  const detect = layoutFn();
  const noProbe = () => {
    throw new Error("形状明确时不应探测版本");
  };
  assert.equal(detect({ mcp: { servers: {} } }, noProbe), "v2");
  assert.equal(detect({ mcp: { other: { type: "local", command: ["x"] } } }, noProbe), "v1");
  assert.equal(detect({ mcp: { other: { type: "remote", url: "https://x" } } }, noProbe), "v1");
});

test("detectOpenCodeLayout：形状无线索时按探测版本判定（1→v1，2→v2，探测失败默认 v2）；Claude 风格条目不算 v1 形状", () => {
  const detect = layoutFn();
  const claudeStyle = { mcp: { sediment: { command: "node", args: ["x"], environment: {} } } };
  assert.equal(detect(claudeStyle, () => 1), "v1");
  assert.equal(detect(claudeStyle, () => 2), "v2");
  assert.equal(detect(claudeStyle, () => undefined), "v2");
  assert.equal(detect({}, () => 1), "v1");
  assert.equal(detect({}, () => undefined), "v2");
});

test("configureAgent：OpenCode v2 配置写入 mcp.servers.sediment（type:local + command 数组 + environment）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-v2-"));
  try {
    const cfgPath = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { servers: {} } }), "utf8");
    configureAgent(fakeSetupPlugin(tmp), openCodeTarget(cfgPath));
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const entry = data.mcp.servers.sediment;
    assert.ok(entry, "应写入 mcp.servers.sediment");
    assert.equal(entry.type, "local");
    assert.ok(Array.isArray(entry.command), "command 必须是数组");
    assert.equal(entry.command[0], "node");
    assert.ok(entry.command[1].endsWith("index.mjs"));
    assert.ok(fs.existsSync(entry.command[1]), "桥接路径必须真实存在");
    assert.equal(entry.environment.SEDIMENT_URL, "http://127.0.0.1:27123");
    assert.equal(entry.environment.AGENT_NAME, "opencode");
    assert.equal(data.mcp.sediment, undefined, "不得直挂 mcp.sediment");
    assert.ok(fs.existsSync(cfgPath + ".bak"), "写入前应备份");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("configureAgent：OpenCode v1 配置直挂 mcp.sediment（type:local + command 数组 + enabled）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-v1-"));
  try {
    const cfgPath = path.join(tmp, "opencode.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } }), "utf8");
    configureAgent(fakeSetupPlugin(tmp), openCodeTarget(cfgPath));
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const entry = data.mcp.sediment;
    assert.ok(entry, "v1 应直挂 mcp.sediment");
    assert.equal(entry.type, "local");
    assert.ok(Array.isArray(entry.command));
    assert.equal(entry.command[0], "node");
    assert.equal(entry.enabled, true);
    assert.equal(data.mcp.servers, undefined, "v1 不得创建 mcp.servers");
    assert.ok(data.mcp.other, "不得动其它服务器条目");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("configureAgent：旧 Claude 风格 mcp.sediment 迁移到 v2 位置并清除旧条目", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-migrate-"));
  try {
    const cfgPath = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcp: { sediment: { command: "node", args: ["old.mjs"], environment: {} }, servers: {} } }),
      "utf8"
    );
    configureAgent(fakeSetupPlugin(tmp), openCodeTarget(cfgPath));
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(data.mcp.sediment, undefined, "旧位置条目应被清除");
    assert.equal(data.mcp.servers.sediment.type, "local");
    assert.ok(Array.isArray(data.mcp.servers.sediment.command));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("configureAgent：判定 v1 时清除 mcp.servers.sediment 残留，servers 清空后移除该键", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-v1clean-"));
  try {
    const cfgPath = path.join(tmp, "opencode.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcp: { other: { type: "local", command: ["x"] }, servers: { sediment: { type: "local", command: ["node", "y"] } } } }),
      "utf8"
    );
    configureAgent(fakeSetupPlugin(tmp), openCodeTarget(cfgPath));
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(data.mcp.sediment.type, "local");
    assert.equal(data.mcp.servers, undefined, "清空的 servers 键应移除，避免 v1 误读");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isAgentConfigured：OpenCode 新旧两个位置都识别为已配置", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-configured-"));
  try {
    const cfgPath = path.join(tmp, "opencode.jsonc");
    const target = openCodeTarget(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { servers: { sediment: { type: "local" } } } }), "utf8");
    assert.equal(isAgentConfigured(target), true, "v2 位置应识别");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { sediment: { type: "local" } } }), "utf8");
    assert.equal(isAgentConfigured(target), true, "v1 位置应识别");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcp: { servers: {} } }), "utf8");
    assert.equal(isAgentConfigured(target), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveBridgePath：从 OpenCode command 数组复用库外桥接路径且不覆盖", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-cmd-"));
  try {
    const external = path.join(tmp, "elsewhere", "index.mjs");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.writeFileSync(external, "// user-managed bridge\n", "utf8");
    const cfgPath = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcp: { servers: { sediment: { type: "local", command: ["node", external] } } } }),
      "utf8"
    );
    const bridge = resolveBridgePath(fakeSetupPlugin(tmp), openCodeTarget(cfgPath));
    assert.equal(bridge, external);
    assert.equal(fs.readFileSync(external, "utf8"), "// user-managed bridge\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("configSnippet：opencode 输出 V2 原生结构（mcp.servers + type:local + command 数组）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-snippet-"));
  try {
    const snippet = JSON.parse(configSnippet(fakeSetupPlugin(tmp), "opencode"));
    const entry = snippet.mcp?.servers?.sediment;
    assert.ok(entry, "snippet 应为 mcp.servers.sediment 结构");
    assert.equal(entry.type, "local");
    assert.ok(Array.isArray(entry.command));
    assert.equal(entry.command[0], "node");
    assert.ok(entry.environment.SEDIMENT_TOKEN);
    assert.equal(snippet.mcp.sediment, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("configureAgent：非 OpenCode 客户端保持 command+args+env 结构不变", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-oc-claude-"));
  try {
    const cfgPath = path.join(tmp, "settings.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const target = { id: "qoder", name: "Qoder", configPath: cfgPath, rootKey: "mcpServers" as const, envKey: "env" as const };
    configureAgent(fakeSetupPlugin(tmp), target);
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const entry = data.mcpServers.sediment;
    assert.equal(entry.command, "node");
    assert.ok(Array.isArray(entry.args));
    assert.ok(entry.env.SEDIMENT_TOKEN);
    assert.equal(entry.timeout, 60000);
    assert.equal(entry.type, undefined, "Claude 风格不加 type");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agentCandidates：Cline 用官方 CLI 与 VS Code globalStorage 路径，移除无效的 ~/.opencode.json，补 Windsurf next", () => {
  const fn = (setupNs as unknown as { agentCandidates?: (home: string, appdata: string) => Array<{ id: string; configPath: string }> }).agentCandidates;
  assert.equal(typeof fn, "function", "setup.ts 应导出 agentCandidates 纯函数");
  const candidates = (fn as NonNullable<typeof fn>)("/home/u", "C:/AppData");
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c.configPath]));
  assert.equal(byId["cline"], "/home/u/.cline/data/settings/cline_mcp_settings.json");
  assert.equal(byId["cline-ide"], "C:/AppData/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
  assert.equal(byId["opencode-home"], undefined, "~/.opencode.json 不是任何 OpenCode 版本读取的位置");
  assert.equal(byId["windsurf-next"], "/home/u/.codeium/windsurf-next/mcp_config.json");
  assert.equal(byId["opencode"], "/home/u/.config/opencode/opencode.jsonc");
});

test("configureAgent：Cline 条目不写 timeout（Cline 超时按秒计，60000 会被误读为 60000 秒）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-cline-"));
  try {
    const cfgPath = path.join(tmp, "cline_mcp_settings.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const target = { id: "cline", name: "Cline", configPath: cfgPath, rootKey: "mcpServers" as const, envKey: "env" as const };
    configureAgent(fakeSetupPlugin(tmp), target);
    const entry = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.sediment;
    assert.equal(entry.command, "node");
    assert.ok(Array.isArray(entry.args));
    assert.equal(entry.timeout, undefined, "Cline 不写 timeout");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Store.load：缺失字段补默认值并规范化历史数据", async () => {
  const loadedData = {
    version: 1,
    days: {
      "2026-11-20": {
        wordsAdded: -50,
        wordsRemoved: -3,
        edits: -2,
        notesCreated: -1,
        tasksCompleted: -4,
        focusMinutes: -25,
        hourlyWords: [12, null, "5"],
        capturedWords: -10,
        aiWordsAdded: -20,
        folderWords: null,
        activeMinutes: -8,
      },
    },
  };
  const fakePlugin = {
    loadData: async () => loadedData,
  } as unknown as Parameters<typeof Store>[0];
  const store = new Store(fakePlugin);

  await store.load();

  assert.equal(store.data.version, 1);
  assert.ok(Array.isArray(store.data.memos));
  assert.ok(Array.isArray(store.data.workLogs));
  assert.ok(Array.isArray(store.data.snapshots));
  assert.deepEqual(store.data.settings.language, DEFAULT_SETTINGS.language);
  const normalized = store.getDay("2026-11-20");
  assert.equal(normalized.wordsAdded, 0);
  assert.equal(normalized.wordsRemoved, 0);
  assert.equal(normalized.edits, 0);
  assert.equal(normalized.notesCreated, 0);
  assert.equal(normalized.tasksCompleted, 0);
  assert.equal(normalized.focusMinutes, 0);
  assert.equal(normalized.hourlyWords.length, 24);
  assert.equal(normalized.hourlyWords[0], 12);
  assert.equal(normalized.hourlyWords[1], 0);
  assert.equal(normalized.hourlyWords[2], 5);
  assert.deepEqual(normalized.folderWords, {});
  assert.equal(normalized.activeMinutes, 0);
  assert.equal(normalized.capturedWords, 0);
  assert.equal(normalized.aiWordsAdded, 0);
});

test("Store.load：未知版本暂停写入并保留警告", async () => {
  let saveCalls = 0;
  const fakePlugin = {
    loadData: async () => ({ version: 99, days: { "2026-11-20": day({ wordsAdded: 100 }) } }),
    saveData: async () => { saveCalls += 1; },
  } as unknown as Parameters<typeof Store>[0];
  const store = new Store(fakePlugin);

  await store.load();
  await store.save();

  assert.match(store.migrationWarning ?? "", /不支持的数据版本 99/);
  assert.equal(saveCalls, 0);
  assert.equal(store.getDay("2026-11-20").wordsAdded, 100);
});

test("Store.load：缺少版本或格式异常暂停写入", async () => {
  for (const raw of ["broken", []]) {
    let saveCalls = 0;
    const fakePlugin = {
      loadData: async () => raw,
      saveData: async () => { saveCalls += 1; },
    } as unknown as Parameters<typeof Store>[0];
    const store = new Store(fakePlugin);

    await store.load();
    await store.save();

    assert.ok(store.migrationWarning);
    assert.equal(saveCalls, 0);
  }
});

// ---------- 存储层可靠性（Task 5） ----------

/** 构造带 adapter/getFiles/trash 的假 vault，记录写入与删除。 */
function fakeVault(files: Array<{ path: string; mtime?: number; size?: number }> = []) {
  const written: Array<[string, string]> = [];
  const trashed: string[] = [];
  const folders = new Set<string>();
  const tfiles = files.map((f) => {
    const name = f.path.split("/").pop() ?? "";
    return {
      path: f.path,
      name,
      basename: name.replace(/\.[^.]+$/, ""),
      extension: name.includes(".") ? name.split(".").pop() ?? "" : "",
      stat: { ctime: 0, mtime: f.mtime ?? 0, size: f.size ?? 0 },
    };
  });
  const vault = {
    adapter: {
      write: async (path: string, content: string) => { written.push([path, content]); },
      read: async (path: string) => {
        const hit = written.find(([p]) => p === path);
        if (!hit) throw new Error(`no such file: ${path}`);
        return hit[1];
      },
    },
    getFiles: () => tfiles,
    getAbstractFileByPath: (path: string) =>
      tfiles.find((f) => f.path === path) ?? (folders.has(path) ? { path } : null),
    createFolder: async (path: string) => { folders.add(path); },
    trash: async (file: { path: string }) => { trashed.push(file.path); },
  };
  return { vault, written, trashed };
}

function fakePluginWith(vault: ReturnType<typeof fakeVault>["vault"], raw: unknown) {
  let current = raw;
  const saved: unknown[] = [];
  const plugin = {
    loadData: async () => current,
    saveData: async (data: unknown) => { saved.push(data); current = data; },
    app: { vault },
  };
  return { plugin: plugin as unknown as Parameters<typeof Store>[0], saved };
}

test("Store.load：结构性损坏保留恢复副本并阻塞写入", async () => {
  const raw = { version: 1, days: [], memos: "not-an-array", workLogs: [{ id: "x" }] };
  const { vault, written } = fakeVault();
  const { plugin, saved } = fakePluginWith(vault, raw);
  const store = new Store(plugin);

  await store.load();
  await store.save();

  assert.match(store.migrationWarning ?? "", /数据结构损坏/);
  assert.match(store.migrationWarning ?? "", /days/);
  assert.match(store.migrationWarning ?? "", /memos/);
  assert.equal(store.isPersistenceBlocked, true);
  assert.equal(saved.length, 0);
  // 恢复副本落在插件 recovery 目录，内容保留原始数据。
  assert.ok(store.recoveryCopyPath?.startsWith(".obsidian/plugins/sediment/recovery/data-"));
  const copy = written.find(([p]) => p === store.recoveryCopyPath);
  assert.ok(copy);
  assert.deepEqual(JSON.parse(copy[1]), raw);
  // 损坏字段不再静默重置：内存态仍可供只读展示。
  assert.deepEqual(store.data.days, {});
  assert.deepEqual(store.data.memos, []);
});

test("Store.load：pendingWrites 损坏同样阻塞写入并保留恢复副本", async () => {
  const raw = { version: 1, pendingWrites: "x" };
  const { vault, written } = fakeVault();
  const { plugin, saved } = fakePluginWith(vault, raw);
  const store = new Store(plugin);

  await store.load();
  await store.save();

  assert.match(store.migrationWarning ?? "", /数据结构损坏/);
  assert.match(store.migrationWarning ?? "", /pendingWrites/);
  assert.equal(store.isPersistenceBlocked, true);
  assert.equal(saved.length, 0);
  assert.ok(store.recoveryCopyPath?.startsWith(".obsidian/plugins/sediment/recovery/data-"));
  const copy = written.find(([p]) => p === store.recoveryCopyPath);
  assert.ok(copy);
  assert.deepEqual(JSON.parse(copy[1]), raw);
});

test("Store.load：无版本号且形状符合 v1 时自动迁移写回", async () => {
  const raw = { days: { "2026-11-20": { wordsAdded: 100 } }, memos: [] };
  const { vault } = fakeVault();
  const { plugin, saved } = fakePluginWith(vault, raw);
  const store = new Store(plugin);

  await store.load();

  assert.equal(store.migrationWarning, null);
  assert.equal(store.isPersistenceBlocked, false);
  assert.equal(saved.length, 1);
  assert.equal((saved[0] as { version: number }).version, 1);
  assert.equal(store.data.version, 1);
  assert.equal(store.getDay("2026-11-20").wordsAdded, 100);
  await store.save();
  assert.equal(saved.length, 2);
});

test("Store.load：版本号写回失败时阻塞写入并保留恢复副本", async () => {
  const raw = { days: {}, memos: [] };
  const { vault, written } = fakeVault();
  const plugin = {
    loadData: async () => raw,
    saveData: async () => { throw new Error("disk full"); },
    app: { vault },
  } as unknown as Parameters<typeof Store>[0];
  const store = new Store(plugin);

  await store.load();
  await store.save();

  assert.equal(store.isPersistenceBlocked, true);
  assert.match(store.migrationWarning ?? "", /迁移失败/);
  assert.ok(written.some(([p]) => p.startsWith(".obsidian/plugins/sediment/recovery/")));
});

test("Store.backupData：库根目录只备份不清理", async () => {
  const { vault, written, trashed } = fakeVault([
    { path: "data-user-notes.json", mtime: 1 },
    { path: "data-2020-01-01-0000.json", mtime: 2 },
  ]);
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();
  store.data.settings.backupFolder = "";
  store.data.settings.backupKeep = 1;

  const count = await store.backupData(true);

  assert.equal(count, 1);
  assert.equal(written.length, 1);
  assert.match(written[0][0], /^data-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  assert.equal(trashed.length, 0);
});

test("Store.backupData：正常目录按保留份数清理，不误删目录外文件", async () => {
  const { vault, trashed } = fakeVault([
    { path: "sediment-backup/data-2026-11-18-0800.json", mtime: 1 },
    { path: "sediment-backup/data-2026-11-19-0800.json", mtime: 2 },
    { path: "sediment-backup/data-2026-11-20-0800.json", mtime: 3 },
    { path: "data-root.json", mtime: 0 },
    { path: "sediment-backup/sub/data-nested.json", mtime: 0 },
  ]);
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();
  store.data.settings.backupKeep = 2;

  const count = await store.backupData(true);

  assert.equal(count, 1);
  // 新备份不在 getFiles 列表里，列表中最旧的一份被清理。
  assert.deepEqual(trashed, ["sediment-backup/data-2026-11-18-0800.json"]);
});

test("Store.backupData：写入失败抛错且不占用节流窗口", async () => {
  const { vault } = fakeVault();
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();
  const originalWrite = vault.adapter.write;
  vault.adapter.write = async () => { throw new Error("permission denied"); };

  await assert.rejects(() => store.backupData(true), /permission denied/);

  vault.adapter.write = originalWrite;
  // 失败未更新 lastBackupAt：不带 force 也能立即重试成功。
  assert.equal(await store.backupData(), 1);
});

test("Store.save：保存失败弹 Notice 并记录错误，不向调用方抛错", async () => {
  const { vault } = fakeVault();
  const plugin = {
    loadData: async () => null,
    saveData: async () => { throw new Error("disk full"); },
    app: { vault },
  } as unknown as Parameters<typeof Store>[0];
  const store = new Store(plugin);
  await store.load();
  const messages = (Notice as unknown as { messages: string[] }).messages;
  messages.length = 0;
  const originalError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  try {
    await store.save();
  } finally {
    console.error = originalError;
  }
  assert.ok(logged > 0);
  assert.ok(messages.some((m) => m.includes("数据保存失败")));
});

test("Store.listDataBackups：只列备份目录内 data 快照，按时间倒序", async () => {
  const { vault } = fakeVault([
    { path: "sediment-backup/data-2026-11-19-0800.json", mtime: 200, size: 20 },
    { path: "sediment-backup/data-2026-11-20-0800.json", mtime: 300, size: 30 },
    { path: "sediment-backup/notes.json", mtime: 400, size: 5 },
    { path: "sediment-backup/sub/data-nested.json", mtime: 500, size: 5 },
    { path: "data-root.json", mtime: 600, size: 5 },
    { path: "sediment-backup/data-2026-11-18-0800.md", mtime: 700, size: 5 },
  ]);
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();

  const backups = store.listDataBackups();

  assert.deepEqual(backups, [
    { name: "data-2026-11-20-0800.json", savedAt: 300, size: 30 },
    { name: "data-2026-11-19-0800.json", savedAt: 200, size: 20 },
  ]);
});

test("Store.restoreDataBackup：恢复备份、保留当前数据副本并重载内存态", async () => {
  const backupName = "data-2026-11-19-0800.json";
  const backupContent = JSON.stringify({
    version: 1,
    days: { "2026-11-19": { wordsAdded: 100 } },
    memos: [],
  });
  const { vault, written } = fakeVault([
    { path: `sediment-backup/${backupName}`, mtime: 200, size: backupContent.length },
  ]);
  written.push([`sediment-backup/${backupName}`, backupContent]);
  // 当前数据版本异常 → 阻塞；恢复后应解除。
  const { plugin, saved } = fakePluginWith(vault, { version: 99, days: {} });
  const store = new Store(plugin);
  await store.load();
  assert.equal(store.isPersistenceBlocked, true);

  const result = await store.restoreDataBackup(backupName);

  assert.equal(result.recovery, "saved");
  assert.ok(result.recoveryPath.startsWith(".obsidian/plugins/sediment/recovery/data-"));
  const copy = written.find(([p]) => p === result.recoveryPath);
  assert.deepEqual(JSON.parse(copy![1]), { version: 99, days: {} });
  assert.equal(store.isPersistenceBlocked, false);
  assert.equal(store.migrationWarning, null);
  assert.equal(store.getDay("2026-11-19").wordsAdded, 100);
  assert.equal((saved[saved.length - 1] as { version: number }).version, 1);
  await store.save();
  assert.equal(store.isPersistenceBlocked, false);
});

test("Store.restoreDataBackup：拒绝路径穿越与不存在的备份", async () => {
  const { vault } = fakeVault();
  const { plugin, saved } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();

  for (const name of ["../evil.json", "sub/data-x.json", "..\\evil.json", "data-..%2f.json", "evil.json"]) {
    await assert.rejects(() => store.restoreDataBackup(name), /备份文件名不合法/);
  }
  await assert.rejects(
    () => store.restoreDataBackup("data-1999-01-01-0000.json"),
    /备份不存在或已被清理/
  );
  assert.equal(saved.length, 0);
});

test("Store.restoreDataBackup：备份内容损坏时拒绝恢复", async () => {
  const backupName = "data-2026-11-19-0800.json";
  const { vault, written } = fakeVault([
    { path: `sediment-backup/${backupName}`, mtime: 200, size: 10 },
  ]);
  const { plugin, saved } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();

  written.push([`sediment-backup/${backupName}`, JSON.stringify({ version: 1, days: [] })]);
  await assert.rejects(() => store.restoreDataBackup(backupName), /备份内容损坏/);
  written.length = 0;
  written.push([`sediment-backup/${backupName}`, "{not json"]);
  await assert.rejects(() => store.restoreDataBackup(backupName), /备份内容损坏/);
  assert.equal(saved.length, 0);
});

test("Agent 安全路径：拒绝穿越、系统目录和非 Markdown", () => {
  const cases = [
    "../secret.md",
    "notes/../../secret.md",
    ".obsidian/data.json",
    ".git/config",
    "notes/file.txt",
    "",
  ];
  for (const value of cases) {
    assert.throws(() => safeAgentPath(value), ApiError);
  }
});

test("Agent 安全路径：规范化反斜杠并保留合法路径", () => {
  assert.equal(safeAgentPath("notes\\daily\\2026.md"), "notes/daily/2026.md");
  assert.equal(safeAgentPath("/notes//memo.md"), "notes/memo.md");
});

test("Store：工作日志保留上限，避免无界增长", () => {
  const store = new Store({} as unknown as Parameters<typeof Store>[0]);
  store.scheduleSave = () => {};
  for (let index = 0; index < 520; index += 1) {
    store.addWorkLog({
      id: `log-${index}`,
      date: "2026-11-20",
      time: "08:00",
      agent: "test",
      task: "task",
      summary: "summary",
      decisions: "",
      learnings: "",
      openQuestions: "",
      tags: [],
      files: [],
    });
  }
  assert.equal(store.data.workLogs.length, 500);
  assert.equal(store.data.workLogs[0].id, "log-519");
});

test("Store：速记保留上限，避免无界增长", () => {
  const store = new Store({} as unknown as Parameters<typeof Store>[0]);
  store.scheduleSave = () => {};
  for (let index = 0; index < 2020; index += 1) {
    store.addMemo({
      id: `memo-${index}`,
      date: "2026-11-20",
      time: "08:00",
      text: "memo",
      tags: [],
      converted: false,
      archived: false,
    });
  }
  assert.equal(store.data.memos.length, 2000);
  assert.equal(store.data.memos[0].id, "memo-2019");
});

test("语义检索分词：支持中文、英文和混合语言", () => {
  assert.ok(tokenizeSemanticText("配置 MCP").includes("配置"));
  assert.ok(tokenizeSemanticText("配置 MCP").includes("mcp"));
  assert.ok(tokenizeSemanticText("知识库 search").some((token) => token === "知识" || token === "识库"));
  assert.ok(tokenizeSemanticText("TF-IDF").includes("tf"));
});

test("幂等键：相同工具/调用者/参数稳定，参数变化则变化", () => {
  const first = idempotencyKey("write_note", "qoder", { path: "a.md", content: "x" });
  const second = idempotencyKey("write_note", "qoder", { content: "x", path: "a.md" });
  const changed = idempotencyKey("write_note", "qoder", { path: "a.md", content: "y" });
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("审计脱敏：路径去掉查询串，已知令牌被替换", () => {
  assert.equal(redactAuditPath("notes/a.md?token=secret123&x=1"), "notes/a.md");
  assert.equal(redactAuditPath("notes/a.md#heading"), "notes/a.md");
  assert.equal(redactSecrets("token=secret123", ["secret123"]), "token=[REDACTED]");
});

test("Store.load：大批量历史数据规范化且不重复计数", async () => {
  const days: Record<string, unknown> = {};
  for (let index = 0; index < 400; index += 1) {
    const date = dateKey(addDays(new Date("2026-01-01T00:00:00"), index));
    days[date] = {
      wordsAdded: index % 7 === 0 ? -5 : index % 3,
      hourlyWords: [1, null, "2"],
      folderWords: null,
      contribution: 999,
    };
  }
  const store = new Store({ loadData: async () => ({ version: 1, days }) } as unknown as Parameters<typeof Store>[0]);
  await store.load();
  assert.equal(Object.keys(store.data.days).length, 400);
  const normalized = store.getDay("2026-01-01");
  assert.equal(normalized.wordsAdded, 0);
  assert.equal(normalized.hourlyWords.length, 24);
  assert.deepEqual(normalized.folderWords, {});
  assert.notEqual(normalized.contribution, 999);
});

test("computeDiff：逐行标记新增与删除，未变化行保留", () => {
  const lines = computeDiff("a\nb\nc", "a\nx\nc\nd");
  assert.equal(lines.filter((line) => line.type === "same").length, 2);
  assert.equal(lines.filter((line) => line.type === "remove").length, 1);
  assert.equal(lines.filter((line) => line.type === "add").length, 2);
  assert.equal(lines.find((line) => line.type === "remove")?.oldLine, "b");
  assert.ok(lines.some((line) => line.type === "add" && line.newLine === "d"));
});

// ---------------------------------------------------------------------------
// 权限统一门禁（v0.9.7 评审修复 H6/H7/M1/M3 + 令牌恒定时间比较）
// ---------------------------------------------------------------------------

/** 构造只够跑门禁路径的假 SedimentPlugin（拒绝分支不触碰 vault）。
 * 这些用例验证权限层，默认钉在 auto 档（无 confirm 挂起，通过即直接落盘）。 */
function fakeAgentPlugin(partial: Partial<PulseSettings> = {}, extra: Record<string, unknown> = {}) {
  const s = settings({ agentWorkMode: "auto", ...partial });
  const calls: Record<string, unknown[]> = { complete: [], delegate: [], snapshot: [] };
  const plugin = {
    store: {
      settings: s,
      data: { snapshots: [], memos: [], workLogs: [], toolCalls: [], days: {}, ...((extra.data as object) ?? {}) },
      logDiagnostic: () => {},
      updateDay: () => {},
      scheduleSave: () => {},
    },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        getMarkdownFiles: () => [],
        createFolder: async () => {},
        create: async (p: string) => new TFileStub(p),
        cachedRead: async () => "",
        read: async () => "",
        configDir: ".obsidian",
      },
      metadataCache: { getFileCache: () => undefined, resolvedLinks: {} },
    },
    tracker: { markAgentWrite: () => {} },
    tasks: {
      complete: async (...args: unknown[]) => { calls.complete.push(args); },
      delegate: async (...args: unknown[]) => { calls.delegate.push(args); return "memo-1"; },
      snapshot: async () => { calls.snapshot.push([]); return 3; },
    },
    ...((extra.plugin as object) ?? {}),
  };
  return { api: new AgentApi(plugin as never), calls };
}

class TFileStub {
  path: string;
  basename: string;
  stat = { ctime: 0, mtime: 0, size: 0 };
  constructor(p: string) {
    this.path = p;
    this.basename = p.split("/").pop() ?? "";
  }
}

const asApiError = (error: unknown): ApiError => {
  assert.ok(error instanceof ApiError, `应抛 ApiError，实际：${String(error)}`);
  return error;
};

test("access：splitList 支持全角逗号与空白项", () => {
  assert.deepEqual(splitList("a，b, c ,,d，"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitList(""), []);
});

test("access：allow-all 分支放行非黑名单路径（白名单为空也放行）", () => {
  const s = { ...accessSettings, agentAccessMode: "allow-all" as const, agentAllowedFolders: "" };
  assert.equal(isPathAllowedByMode("公开/a.md", s), true);
  assert.equal(isPathAllowedByMode("私有/a.md", s), false, "allow-all 也要过黑名单");
});

test("access：create/overwrite/delete 操作矩阵", () => {
  const matrix: Array<["create" | "overwrite" | "delete", keyof PulseSettings]> = [
    ["create", "agentAllowCreate"],
    ["overwrite", "agentAllowOverwrite"],
    ["delete", "agentAllowDelete"],
  ];
  for (const [operation, key] of matrix) {
    for (const allowed of [true, false]) {
      const s = {
        ...accessSettings,
        agentAllowCreate: false,
        agentAllowOverwrite: false,
        agentAllowDelete: false,
        [key]: allowed,
      };
      assert.equal(isOperationAllowed(operation, s), allowed, `${operation}=${allowed}`);
    }
  }
});

test("access：未知 agentAccessMode fail-closed（M3）", () => {
  const bogus = {
    ...accessSettings,
    agentAccessMode: "yolo" as unknown as typeof accessSettings.agentAccessMode,
    agentAllowedFolders: "",
  };
  assert.equal(isPathAllowedByMode("公开/a.md", bogus), false, "未知模式不得放全库");
  const bogusWithList = { ...bogus, agentAllowedFolders: "公开" };
  assert.equal(isPathAllowedByMode("公开/a.md", bogusWithList), true, "未知模式按白名单处理");
  assert.equal(isPathAllowedByMode("其他/a.md", bogusWithList), false);
});

test("access：isSafePathSegmentName 拦截路径穿越分类（M1 规则）", () => {
  assert.equal(isSafePathSegmentName("技术"), true);
  assert.equal(isSafePathSegmentName("a/b"), false);
  assert.equal(isSafePathSegmentName("a\\b"), false);
  assert.equal(isSafePathSegmentName("../evil"), false);
  assert.equal(isSafePathSegmentName("a..b"), false);
});

test("H6：completeTask 受 patch 与黑名单门禁约束", async () => {
  const denied = fakeAgentPlugin({ deniedFolders: "私有" });
  await assert.rejects(denied.api.completeTask("私有/a.md", 3), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN" && e.status === 403;
  });
  assert.equal(denied.calls.complete.length, 0, "被拒绝时不得落到 TaskManager");

  const noPatch = fakeAgentPlugin({ agentAllowPatch: false });
  await assert.rejects(noPatch.api.completeTask("公开/a.md", 3), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && e.status === 403;
  });

  const ok = fakeAgentPlugin();
  await assert.doesNotReject(ok.api.completeTask("公开\\a.md", 3));
  assert.ok(ok.calls.complete.length === 1 && (ok.calls.complete[0][0] as string) === "公开/a.md");
});

test("H6：delegateTask 需要 read 权限且受白名单约束（含日记目标路径）", async () => {
  const { api, calls } = fakeAgentPlugin({
    agentAccessMode: "allowlist",
    agentAllowedFolders: "知识",
    agentAllowRead: true,
  });
  await assert.rejects(api.delegateTask("私有/a.md", 2), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN";
  });
  assert.equal(calls.delegate.length, 0);
  // A1 收口：源笔记在白名单内也不够——delegate 落盘目标是当天日记，
  // 白名单不含日记目录时同样拒绝（旧行为只查源路径，属越权旁路）。
  await assert.rejects(api.delegateTask("知识/a.md", 2), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN" && /daily/.test(e.message);
  });
  assert.equal(calls.delegate.length, 0);

  const ok = fakeAgentPlugin({
    agentAccessMode: "allowlist",
    agentAllowedFolders: "知识, daily",
    agentAllowRead: true,
  });
  await assert.doesNotReject(ok.api.delegateTask("知识/a.md", 2));
  assert.equal(ok.calls.delegate.length, 1);
});

test("H6：snapshotTasks 写当天日记前过 patch 门禁", async () => {
  const { api, calls } = fakeAgentPlugin({ deniedFolders: "daily", agentAllowPatch: true });
  await assert.rejects(api.snapshotTasks(), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN";
  });
  assert.equal(calls.snapshot.length, 0, "被拒绝时不得写日记");

  // 日记已存在时按 patch 过门禁：patch=false 必须拒（日记缺失时按 create，见「终审 3」）。
  const existingDaily = dailyNotePath(settings(), new Date());
  const noPatch = fakeAgentPlugin({ agentAllowPatch: false }, {
    plugin: {
      app: {
        vault: { getAbstractFileByPath: (p: string) => (p === existingDaily ? new TFile(p) : null) },
        metadataCache: { getFileCache: () => undefined, resolvedLinks: {} },
      },
    },
  });
  await assert.rejects(noPatch.api.snapshotTasks(), (error) => asApiError(error).code === "OPERATION_DENIED");

  const ok = fakeAgentPlugin();
  assert.deepEqual(await ok.api.snapshotTasks(), { count: 3 });
});

test("H6：revertAgentChange 恢复前按快照路径过 overwrite 门禁", async () => {
  const snapshots = [{ id: "s1", path: "私有/a.md", time: "2026-11-20T00:00:00Z", tool: "t", agent: "a" }];
  const { api } = fakeAgentPlugin({ deniedFolders: "私有" }, { data: { snapshots } });
  await assert.rejects(api.revertAgentChange("s1"), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN" && e.status === 403;
  });

  const noOverwrite = fakeAgentPlugin({ agentAllowOverwrite: false }, { data: { snapshots } });
  await assert.rejects(noOverwrite.api.revertAgentChange("s1"), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED";
  });
});

test("H7：语义检索遵守白名单模式，越权文档不出现在结果与摘要里", async () => {
  const files = [new TFileStub("知识/甲.md"), new TFileStub("私有/乙.md")];
  const texts: Record<string, string> = {
    "知识/甲.md": "这是关于配置管理的笔记",
    "私有/乙.md": "私密内容：配置了秘密参数",
  };
  const s = settings({
    agentAccessMode: "allowlist",
    agentAllowedFolders: "知识",
    deniedFolders: "",
    deniedTags: "",
  });
  const plugin = {
    store: { settings: s, logDiagnostic: () => {} },
    app: {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: async (file: TFileStub) => texts[file.path] ?? "",
        getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
      },
      metadataCache: { getFileCache: () => undefined },
    },
  };
  const index = new SemanticIndex(plugin as never);
  const hits = await index.search("配置", 10);
  const paths = hits.map((hit) => hit.path);
  assert.ok(paths.includes("知识/甲.md"), "白名单内文档应命中");
  assert.ok(!paths.includes("私有/乙.md"), "白名单外文档必须被过滤");
});

test("M1：addKnowledge 非法 category 回退默认分类并说明", async () => {
  const created: Array<{ path: string; content: string }> = [];
  const plugin = {
    store: {
      settings: settings({ agentWorkMode: "auto" }),
      data: { snapshots: [] },
      logDiagnostic: () => {},
      updateDay: () => {},
    },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => {},
        create: async (p: string, c: string) => {
          created.push({ path: p, content: c });
          return new TFileStub(p);
        },
      },
      metadataCache: { getFileCache: () => undefined },
    },
    tracker: { markAgentWrite: () => {} },
  };
  const api = new AgentApi(plugin as never);

  const evil = await api.addKnowledge({ title: "沉淀", content: "正文", category: "../../evil" });
  assert.ok(!evil.path.includes(".."), `路径不得含 ..：${evil.path}`);
  assert.ok(evil.path.startsWith("knowledge/技术/"), `应回退到默认分类：${evil.path}`);
  assert.ok(evil.note && evil.note.length > 0, "返回信息需说明分类被回退");

  const good = await api.addKnowledge({ title: "沉淀", content: "正文", category: "方法" });
  assert.ok(good.path.startsWith("knowledge/方法/"));
  assert.equal(good.note, undefined);
  assert.equal(created.length, 2, "两次调用都应真实落盘");
});

test("令牌比较：SHA-256 定长 + timingSafeEqual，长度不等不抛异常", () => {
  assert.equal(tokensMatch("secret-token", "secret-token"), true);
  assert.equal(tokensMatch("secret-token", "secret-tokeX"), false);
  assert.equal(tokensMatch("short", "much-longer-token"), false);
  assert.equal(tokensMatch("", ""), true);
});

// ---------------------------------------------------------------------------
// confirm 工作模式真实现（Task 4）+ Task 3 移交验收项
// ---------------------------------------------------------------------------

type HoldResult = { path?: string; pending?: true; pendingId?: string; message?: string; count?: number };

/** 内存版 vault：足够跑通 writeNote/patchNote/frontmatter/日记类落盘与读路径。 */
function memoryVault(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const asFile = (p: string) => new TFile(p);
  const vault = {
    getMarkdownFiles: () => Array.from(store.keys(), asFile),
    getAbstractFileByPath: (p: string) => (store.has(p) ? asFile(p) : null),
    read: async (f: { path: string }) => store.get(f.path) ?? "",
    cachedRead: async (f: { path: string }) => store.get(f.path) ?? "",
    create: async (p: string, c: string) => {
      store.set(p, c);
      return asFile(p);
    },
    createFolder: async () => {},
    modify: async (f: { path: string }, c: string) => {
      store.set(f.path, c);
    },
    process: async (f: { path: string }, cb: (data: string) => string) => {
      store.set(f.path, cb(store.get(f.path) ?? ""));
    },
    trash: async () => {},
    adapter: {},
    configDir: ".obsidian",
  };
  return { store, vault };
}

/** 带完整 pendingWrites 挂起面与真实 TaskManager 的假插件。 */
function fakeConfirmPlugin(partial: Partial<PulseSettings> = {}, files: Record<string, string> = {}) {
  const s = settings(partial);
  const pendingWrites: Array<Record<string, any>> = [];
  const diagnostics: Array<{ category: string; message: string; detail?: string }> = [];
  const { store: fileStore, vault } = memoryVault(files);
  const store: Record<string, any> = {
    settings: s,
    data: { snapshots: [], memos: [], workLogs: [], toolCalls: [], days: {}, pendingWrites },
    logDiagnostic: (category: string, message: string, detail?: string) => {
      diagnostics.push({ category, message, detail });
    },
    updateDay: () => {},
    scheduleSave: () => {},
    todayKey: () => dateKey(new Date()),
    addPendingWrite: (record: Record<string, any>) => {
      pendingWrites.unshift(record);
    },
    removePendingWrite: (id: string) => {
      const index = pendingWrites.findIndex((item) => item.id === id);
      return index < 0 ? undefined : pendingWrites.splice(index, 1)[0];
    },
    addWorkLog: (record: Record<string, any>) => {
      store.data.workLogs.unshift(record);
    },
  };
  const memos = {
    add: async (text: string, tags: string[] = []) => {
      const memo = {
        id: `memo-${store.data.memos.length + 1}`, date: dateKey(new Date()),
        time: "00:00", text, tags, converted: false,
      };
      store.data.memos.push(memo);
      return memo;
    },
    syncTags: async () => {},
  };
  const plugin: Record<string, any> = {
    store,
    app: { vault, metadataCache: { getFileCache: () => undefined, resolvedLinks: {} }, workspace: {} },
    tracker: { markAgentWrite: () => {} },
    memos,
    semantic: { search: async () => [] },
  };
  plugin.tasks = new TaskManager(plugin as never);
  return { api: new AgentApi(plugin as never), tasks: plugin.tasks as TaskManager, store, pendingWrites, diagnostics, files: fileStore, plugin };
}

const pendingIdOf = (result: HoldResult): string => {
  assert.ok(result.pending, `应挂起为待审：${JSON.stringify(result)}`);
  assert.ok(result.pendingId);
  return result.pendingId;
};

test("confirm 档：writeNote 挂起不落盘；采纳落盘、驳回丢弃、门禁先于挂起", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const held = (await ctx.api.writeNote("notes/a.md", "agent 内容", "create")) as HoldResult;
  const id = pendingIdOf(held);
  assert.match(held.message ?? "", /confirm 模式下写入已挂起待审/);
  assert.equal(ctx.files.has("notes/a.md"), false, "挂起期间不得落盘");
  assert.equal(ctx.pendingWrites.length, 1);
  assert.equal(ctx.pendingWrites[0].tool, "write_note");
  assert.equal(ctx.pendingWrites[0].after, "agent 内容");
  assert.deepEqual(ctx.pendingWrites[0].request.args.path, "notes/a.md");

  await ctx.api.approvePendingWrite(id);
  assert.equal(ctx.files.get("notes/a.md"), "agent 内容", "采纳后按原请求真正落盘");
  assert.equal(ctx.pendingWrites.length, 0);
  assert.ok(ctx.diagnostics.some((d) => /采纳并落盘/.test(d.message)));

  const second = (await ctx.api.writeNote("notes/b.md", "x", "create")) as HoldResult;
  ctx.api.rejectPendingWrite(pendingIdOf(second));
  assert.equal(ctx.files.has("notes/b.md"), false);
  assert.equal(ctx.pendingWrites.length, 0);
  assert.ok(ctx.diagnostics.some((d) => d.category === "security" && /驳回并丢弃/.test(d.message)));

  assert.throws(() => ctx.api.rejectPendingWrite("nope"), (error) => asApiError(error).code === "NOT_FOUND");
  await assert.rejects(ctx.api.approvePendingWrite("nope"), (error) => asApiError(error).code === "NOT_FOUND");

  // 顺序契约：权限检查 → confirm 拦截。黑名单目录直接 403，不产生挂起项。
  const denied = fakeConfirmPlugin({ agentWorkMode: "confirm", deniedFolders: "notes" });
  await assert.rejects(denied.api.writeNote("notes/c.md", "x"), (error) => asApiError(error).code === "FORBIDDEN");
  assert.equal(denied.pendingWrites.length, 0, "越权写入不得转挂起");
});

test("confirm 档：patchNote 挂起并保留 before/after 预览，采纳后写入", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "line1\nline2\n" });
  const res = (await ctx.api.patchNote({ path: "notes/a.md", find: "line1", content: "LINE-A" })) as HoldResult & {
    diffSummary?: unknown;
  };
  const id = pendingIdOf(res);
  assert.equal(ctx.files.get("notes/a.md"), "line1\nline2\n", "挂起期间原文不动");
  assert.equal(ctx.pendingWrites[0].before, "line1\nline2\n");
  assert.equal(ctx.pendingWrites[0].after, "LINE-A\nline2\n");
  assert.ok(res.diffSummary, "返回值仍带 diffSummary 等旧字段");

  await ctx.api.approvePendingWrite(id);
  assert.equal(ctx.files.get("notes/a.md"), "LINE-A\nline2\n");

  // dryRun 不挂起：它本来就不落盘。
  const dry = (await ctx.api.patchNote({ path: "notes/a.md", find: "LINE-A", content: "z", dryRun: true })) as HoldResult;
  assert.equal(dry.pending, undefined);
  assert.equal(ctx.pendingWrites.length, 0);
});

test("confirm 档：只读路径（read/list/search/context）不受挂起影响", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "内容甲" });
  const read = await ctx.api.readNote("notes/a.md");
  assert.equal(read.content, "内容甲");
  assert.equal(ctx.api.listNotes("", 10).length, 1);
  const hits = await ctx.api.searchNotes("内容");
  assert.equal(hits.length, 1);
  const tasks = await ctx.api.listTasks("all");
  assert.ok(Array.isArray(tasks));
  assert.equal(ctx.pendingWrites.length, 0, "读操作一律不挂起");
});

test("工作模式四档矩阵：readonly 拒写 / draft 直写草稿 / confirm 挂起 / auto 直写", async () => {
  // 各档开关取 settings-tab onChange 的真实组合
  const flags = {
    readonly: { agentAllowRead: true, agentAllowCreate: false, agentAllowPatch: false, agentAllowOverwrite: false },
    draft: { agentAllowRead: true, agentAllowCreate: true, agentAllowPatch: false, agentAllowOverwrite: false },
    confirm: { agentAllowRead: true, agentAllowCreate: true, agentAllowPatch: true, agentAllowOverwrite: true },
    auto: { agentAllowRead: true, agentAllowCreate: true, agentAllowPatch: true, agentAllowOverwrite: true },
  } as const;

  const ro = fakeConfirmPlugin({ agentWorkMode: "readonly", ...flags.readonly });
  await assert.rejects(ro.api.writeNote("a.md", "x"), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && /readonly 模式拒绝写入/.test(e.message);
  });
  assert.equal(ro.files.size, 0);
  assert.equal(ro.api.listNotes("", 10).length, 0, "只读档读取不受影响");

  const draft = fakeConfirmPlugin({ agentWorkMode: "draft", ...flags.draft });
  const draftRes = (await draft.api.writeNote("knowledge/d.md", "草稿")) as HoldResult;
  assert.equal(draftRes.pending, undefined, "draft 档写入直接落盘（草稿流），不挂起");
  assert.equal(draft.files.get("knowledge/d.md"), "草稿");
  await assert.rejects(draft.api.patchNote({ path: "knowledge/d.md", find: "草稿", content: "y" }), (error) => asApiError(error).code === "OPERATION_DENIED");

  const confirm = fakeConfirmPlugin({ agentWorkMode: "confirm", ...flags.confirm });
  const heldRes = (await confirm.api.writeNote("b.md", "x")) as HoldResult;
  assert.ok(heldRes.pending);
  assert.equal(confirm.files.has("b.md"), false);

  const auto = fakeConfirmPlugin({ agentWorkMode: "auto", ...flags.auto });
  const autoRes = (await auto.api.writeNote("c.md", "x")) as HoldResult;
  assert.equal(autoRes.pending, undefined);
  assert.equal(auto.files.get("c.md"), "x");
  assert.equal(auto.pendingWrites.length, 0, "auto 档不产生挂起项");
});

test("confirm 档：速记 / 工作日志 / 勾选待办挂起，采纳走真实落盘函数", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "daily/2020-01-01.md": "- [ ] 写测试\n" });

  const memoRes = (await ctx.api.addMemo("灵感一条", ["idea"])) as HoldResult;
  const memoId = pendingIdOf(memoRes);
  assert.equal(ctx.store.data.memos.length, 0, "挂起期间速记不入库");
  assert.equal(ctx.pendingWrites.find((r) => r.tool === "add_memo")?.path, dailyNotePath(ctx.store.settings, new Date()));

  const logRes = (await ctx.api.recordWorkLog({ task: "t", summary: "s" })) as HoldResult;
  const logId = pendingIdOf(logRes);
  const logPath = `agent-logs/${dateKey(new Date())}.md`;
  assert.equal(ctx.files.has(logPath), false, "挂起期间不建工作日志");
  assert.ok(String(ctx.pendingWrites.find((r) => r.tool === "record_work_log")?.after).includes("**完成了什么**"));

  const completeRes = (await ctx.api.completeTask("daily/2020-01-01.md", 1)) as HoldResult;
  const completeId = pendingIdOf(completeRes);
  const completeRec = ctx.pendingWrites.find((r) => r.tool === "complete_task");
  assert.equal(completeRec?.before, "- [ ] 写测试\n");
  assert.equal(completeRec?.after, "- [x] 写测试\n", "预览与 TaskManager.complete 共用 toggleCheckboxLine");

  await ctx.api.approvePendingWrite(completeId);
  assert.equal(ctx.files.get("daily/2020-01-01.md"), "- [x] 写测试\n");
  await ctx.api.approvePendingWrite(memoId);
  assert.equal(ctx.store.data.memos.length, 1);
  await ctx.api.approvePendingWrite(logId);
  assert.ok(String(ctx.files.get(logPath)).includes("**完成了什么**"));
  assert.equal(ctx.pendingWrites.length, 0);
});

test("confirm 档：delegateTask 挂起不落盘，采纳走 memo 重放；bypass 面直接生效；readonly 拒、auto 不受影响", async () => {
  const taskFile = { "notes/a.md": "- [ ] 交给agent\n- [ ] 别的\n" };

  // confirm：挂起为 memo 同款待审项，不落盘
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, taskFile);
  const held = (await ctx.api.delegateTask("notes/a.md", 1)) as HoldResult;
  const id = pendingIdOf(held);
  assert.equal(ctx.store.data.memos.length, 0, "挂起期间不得创建 Agent 任务");
  assert.equal(ctx.pendingWrites.length, 1);
  const rec = ctx.pendingWrites[0];
  assert.equal(rec.tool, "delegate_task");
  assert.equal(rec.request.kind, "memo", "kind 复用 memo，采纳走 addMemo 真实落盘");
  assert.equal(rec.path, dailyNotePath(ctx.store.settings, new Date()));
  assert.ok(String(rec.after).includes("交给agent"));
  assert.ok(String(rec.after).includes("#to-agent"));

  await ctx.api.approvePendingWrite(id);
  assert.equal(ctx.store.data.memos.length, 1);
  assert.deepEqual(ctx.store.data.memos[0].tags, ["to-agent"]);
  assert.equal(ctx.pendingWrites.length, 0);

  // 人用看板调用面：bypassConfirm=true 直接生效，不产生挂起项
  await ctx.api.delegateTask("notes/a.md", 2, true);
  assert.equal(ctx.store.data.memos.length, 2);
  assert.equal(ctx.pendingWrites.length, 0, "bypass 面不挂起");

  // readonly：delegate 内部写日记，必须被写权限门禁拒绝
  const ro = fakeConfirmPlugin({
    agentWorkMode: "readonly",
    agentAllowRead: true,
    agentAllowCreate: false,
    agentAllowPatch: false,
    agentAllowOverwrite: false,
  }, taskFile);
  await assert.rejects(ro.api.delegateTask("notes/a.md", 1), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && /readonly 模式拒绝写入/.test(e.message);
  });
  assert.equal(ro.store.data.memos.length, 0);
  assert.equal(ro.pendingWrites.length, 0, "被拒的越权写不得转挂起");

  // auto：直接落盘，不受影响
  const auto = fakeConfirmPlugin({ agentWorkMode: "auto" }, taskFile);
  const res = (await auto.api.delegateTask("notes/a.md", 1)) as HoldResult & { id?: string };
  assert.equal(res.pending, undefined);
  assert.ok(res.id);
  assert.equal(auto.store.data.memos.length, 1);
  assert.equal(auto.pendingWrites.length, 0);
});

test("pendingWrites：旧 data.json 缺字段默认空数组，往返保存不丢", async () => {
  // 迁移兼容：缺字段 → 空数组
  let saved: Record<string, any> | null = null;
  const plugin1 = {
    loadData: async () => ({ version: 1 }),
    saveData: async (data: Record<string, any>) => {
      saved = JSON.parse(JSON.stringify(data));
    },
  } as unknown as Parameters<typeof Store>[0];
  const store1 = new Store(plugin1);
  store1.scheduleSave = () => {};
  await store1.load();
  assert.deepEqual(store1.data.pendingWrites, []);

  const record = {
    id: "pw-1", time: "2026-11-20T00:00:00.000Z", tool: "write_note", agent: "qoder",
    path: "notes/a.md", request: { kind: "write_note", args: { path: "notes/a.md", content: "x", mode: "create" } },
    before: "", after: "x",
  };
  store1.addPendingWrite({ ...record });
  assert.equal(store1.data.pendingWrites.length, 1);
  await store1.save();
  assert.ok(saved);
  assert.deepEqual((saved as Record<string, any>).pendingWrites, [record]);

  // 往返：重启加载后挂起项保留（设计意图：跨重启待审），坏条目被过滤
  const plugin2 = {
    loadData: async () => ({
      version: 1,
      pendingWrites: [
        "坏数据",
        { id: "pw-no-request", time: "t", tool: "x", agent: "a", path: "p.md", before: "", after: "" },
        record,
      ],
    }),
    saveData: async () => {},
  } as unknown as Parameters<typeof Store>[0];
  const store2 = new Store(plugin2);
  store2.scheduleSave = () => {};
  await store2.load();
  assert.equal(store2.data.pendingWrites.length, 1, "非对象与缺 request.kind 的畸形条目都要被过滤");
  assert.equal(store2.data.pendingWrites[0].id, "pw-1");
  assert.equal(store2.removePendingWrite("pw-1")?.path, "notes/a.md");
  assert.equal(store2.data.pendingWrites.length, 0);
});

test("移交项 2：dailyNotePath 统一三处路径口径", () => {
  assert.equal(dailyNotePath({ dailyNoteFolder: "/daily/", dailyNoteFormat: "YYYY-MM-DD" }, new Date(2026, 0, 5)), "daily/2026-01-05.md");
  assert.equal(dailyNotePath({ dailyNoteFolder: "", dailyNoteFormat: "YYYY年MM月DD日" }, new Date(2026, 10, 19)), "2026年11月19日.md");
  assert.equal(dailyNotePath({ dailyNoteFolder: "d", dailyNoteFormat: "" }, new Date(2026, 0, 5)), "d/2026-01-05.md", "空格式回退 YYYY-MM-DD");
  assert.equal(dailyNotePath({ dailyNoteFolder: "daily", dailyNoteFormat: "YYYY/MM/DD" }, new Date(2026, 0, 5)), "daily/2026/01/05.md");
});

test("移交项 1：越权目录待办不进入 Agent listTasks / snapshotTasks，人用 UI 不过滤", async () => {
  const files = {
    "daily/2020-01-01.md": "- [ ] 公开待办\n",
    "私有/2020-01-01.md": "- [ ] 私密待办\n",
  };
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto", deniedFolders: "私有" }, files);

  const human = await ctx.tasks.list("overdue");
  assert.ok(human.some((item) => item.text === "私密待办"), "人用 UI 调用面保持不过滤");

  const agent = await ctx.api.listTasks("overdue");
  assert.ok(agent.some((item) => item.text === "公开待办"));
  assert.ok(!agent.some((item) => item.text === "私密待办"), "黑名单目录待办不得泄露给 Agent");

  const res = (await ctx.api.snapshotTasks()) as HoldResult & { count: number };
  assert.equal(res.count, 1);
  const dailyPath = dailyNotePath(ctx.store.settings, new Date());
  const written = ctx.files.get(dailyPath) ?? "";
  assert.ok(written.includes("公开待办"));
  assert.ok(!written.includes("私密待办"), "snapshot 源侧同样过滤");
});

test("confirm 档：snapshotTasks 预览同样只数可访问待办", async () => {
  const files = {
    "daily/2020-01-01.md": "- [ ] 公开待办\n",
    "私有/2020-01-01.md": "- [ ] 私密待办\n",
  };
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm", deniedFolders: "私有" }, files);
  const res = (await ctx.api.snapshotTasks()) as HoldResult;
  const id = pendingIdOf(res);
  assert.match(String(ctx.pendingWrites[0].after), /将 1 条遗留待办写入/, "挂起预览不含越权待办");
  assert.ok(!String(ctx.pendingWrites[0].after).includes("私密待办"));
  await ctx.api.approvePendingWrite(id);
  const written = ctx.files.get(dailyNotePath(ctx.store.settings, new Date())) ?? "";
  assert.ok(written.includes("公开待办"));
  assert.ok(!written.includes("私密待办"));
});

// ---------------------------------------------------------------------------
// Task 6：统计与特性正确性（可注入时钟 / Obsidian 桩的行为测试）
// ---------------------------------------------------------------------------

const newTFile = TFile as unknown as new (path: string) => TFile;
const noticeMessages = (Notice as unknown as { messages: string[] }).messages;

/** 手动推进的假时钟：驱动去抖与 Agent 抑制窗口，不依赖真实时间。 */
function fakeClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number): void {
      timers.delete(id);
    },
    /** 只推进时间、不触发任何定时器：模拟后台节流下定时器延迟触发的竞态。 */
    jump(ms: number): void {
      now += ms;
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let bestId = -1;
        let best: { at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (best === null || timer.at < best.at)) {
            best = timer;
            bestId = id;
          }
        }
        if (best === null) break;
        timers.delete(bestId);
        now = best.at;
        best.fn();
      }
      now = target;
    },
  };
}

/** tracker 行为测试桩：假 vault + 假 store + 可注入时钟。 */
function trackerHarness(
  initial: Record<string, string>,
  clock = fakeClock(new Date(2026, 10, 20, 9, 0, 0).getTime())
) {
  const contents = new Map<string, string>(Object.entries(initial));
  const files = new Map<string, TFile>();
  const fileFor = (path: string): TFile => {
    let file = files.get(path);
    if (!file) {
      file = new newTFile(path);
      files.set(path, file);
    }
    return file;
  };
  const handlers = new Map<string, Array<(file: TFile) => void>>();
  const vault = {
    getMarkdownFiles: () => [...contents.keys()].map(fileFor),
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    on: (name: string, cb: (file: TFile) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(cb);
      handlers.set(name, list);
      return {};
    },
  };
  const days: Record<string, DayRecord> = {};
  const store = {
    data: { editSessions: {} as Record<string, string[]> },
    settings: settings(),
    todayKey: () => dateKey(new Date(clock.now())),
    updateDay: (key: string, mutate: (d: DayRecord) => void) => {
      const d = (days[key] ??= createEmptyDay());
      mutate(d);
      return d;
    },
  };
  const plugin = { app: { vault }, registerEvent: () => {} };
  const tracker = new Tracker(plugin as unknown as Plugin, store as unknown as Store, clock);
  const fire = (name: string, path: string): void => {
    for (const cb of handlers.get(name) ?? []) cb(fileFor(path));
  };
  // 推进假时钟后冲刷微任务，等待 async 的 onModify/settle 完成。
  const advance = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { tracker, clock, contents, days, fire, advance };
}

test("tracker：Agent 抑制期内人的编辑不被吞，窗口结束按实际 diff 补计", async () => {
  const h = trackerHarness({ "notes/a.md": "hello world" }); // 基线 2 词
  await h.tracker.start();
  const key = dateKey(new Date(h.clock.now()));

  h.tracker.markAgentWrite("notes/a.md");
  h.contents.set("notes/a.md", "hello world agent added three"); // Agent 写到 5 词
  h.fire("modify", "notes/a.md");
  await h.advance(200); // 去抖后处理 Agent 写入事件
  assert.equal(h.days[key]?.wordsAdded ?? 0, 0); // Agent 写不计入 humanWrites

  h.contents.set("notes/a.md", "hello world agent added three human edit"); // 窗口内人 +2 词
  h.fire("modify", "notes/a.md");
  await h.advance(200);
  assert.equal(h.days[key]?.wordsAdded ?? 0, 0); // 抑制期内暂缓计分

  await h.advance(10_000); // 窗口结束，按实际 diff 补计人的编辑
  assert.equal(h.days[key].wordsAdded, 2); // 只补计人的 2 词，而非整段 5 词
  assert.equal(h.days[key].edits, 1);
});

test("tracker：窗口过期后的 modify 走 settle 即返回，不回退基线不重复计分", async () => {
  const clock = fakeClock(new Date(2026, 10, 20, 9, 0, 0).getTime());
  const h = trackerHarness({ "notes/a.md": "hello world" }, clock); // 基线 2 词
  await h.tracker.start();
  const key = dateKey(new Date(clock.now()));

  h.tracker.markAgentWrite("notes/a.md");
  h.contents.set("notes/a.md", "hello world agent added three"); // Agent 写到 5 词
  h.fire("modify", "notes/a.md");
  await h.advance(200); // Agent 事件记为基准快照
  assert.equal(h.days[key]?.wordsAdded ?? 0, 0);

  // 人的编辑去抖回调已触发、onModify 正挂起等待快照读取；
  // 此时时间越过窗口末尾，但 settle 定时器被节流尚未触发。
  h.contents.set("notes/a.md", "hello world agent added three human edit"); // 7 词
  h.fire("modify", "notes/a.md");
  clock.advance(120); // 去抖触发，onModify 读到 7 词快照后挂起
  clock.jump(10_000); // 时间越过 endsAt，settle 定时器仍未触发
  h.contents.set("notes/a.md", "hello world agent added three human edit more"); // 8 词
  h.fire("modify", "notes/a.md");
  await new Promise<void>((resolve) => setImmediate(resolve));
  // 过期分支：settle 按最新 8 词快照补计 8-5=3 词后必须直接返回，
  // 不得再用 settle 前的 7 词旧快照回退基线。
  assert.equal(h.days[key].wordsAdded, 3);
  assert.equal(h.days[key].wordsRemoved, 0);
  assert.equal(h.days[key].edits, 1);

  // 后续编辑以 settle 后的 8 词基线计算，不因基线回退重复计分。
  await h.advance(200);
  assert.equal(h.days[key].wordsAdded, 3);
  assert.equal(h.days[key].wordsRemoved, 0);
});

test("tracker：无基线文件只建基线，不把整篇内容误计为新增", async () => {
  const h = trackerHarness({});
  await h.tracker.start();
  const key = dateKey(new Date(h.clock.now()));

  h.contents.set("notes/new.md", "one two three four five"); // 5 词，无基线
  h.fire("modify", "notes/new.md");
  await h.advance(200);
  assert.equal(h.days[key]?.wordsAdded ?? 0, 0); // 只建基线，不计分

  h.contents.set("notes/new.md", "one two three four five six seven"); // +2 词
  h.fire("modify", "notes/new.md");
  await h.advance(200);
  assert.equal(h.days[key].wordsAdded, 2); // 之后的真实新增正常计分
});

/** pomodoro 行为测试桩：可注入 clock 与 setInterval。 */
function pomodoroHarness(
  saved: PersistedPomodoro | null = null,
  start = new Date(2026, 10, 20, 9, 0, 0).getTime()
) {
  let now = start;
  let tickFn: () => void = () => {};
  const days: Record<string, DayRecord> = {};
  const sessions: FocusSessionRecord[] = [];
  const store = {
    data: { pomodoro: saved },
    todayKey: () => dateKey(new Date(now)),
    updateDay: (key: string, mutate: (d: DayRecord) => void) => {
      const d = (days[key] ??= createEmptyDay());
      mutate(d);
      return d;
    },
    addFocusSession: (record: FocusSessionRecord) => {
      sessions.unshift(record);
    },
    scheduleSave: () => {},
  };
  const plugin = {
    store,
    addStatusBarItem: () => ({ setText: () => {} }),
    registerInterval: () => {},
  };
  const manager = new PomodoroManager(plugin as unknown as SedimentPlugin, {
    now: () => now,
    setInterval: (fn) => {
      tickFn = fn;
      return 0;
    },
  });
  return {
    manager,
    store,
    days,
    sessions,
    tick: () => tickFn(),
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
  };
}

test("pomodoro：tick 按时间戳换算 remaining，暂停期间不流逝", () => {
  const h = pomodoroHarness();
  h.manager.start();
  h.setNow(h.getNow() + 100_000); // 真实过去 100s，tick 只执行一次
  h.tick();
  assert.equal(h.manager.state().remaining, 25 * 60 - 100); // 不再每次 tick 只减 1s
  h.manager.pause();
  h.setNow(h.getNow() + 60_000);
  h.tick();
  assert.equal(h.manager.state().remaining, 25 * 60 - 100); // 暂停语义保持
});

test("pomodoro：跨天到期补记归属实际完成日期而非今天", () => {
  const h = pomodoroHarness(null, new Date(2026, 10, 20, 23, 59, 0).getTime());
  h.manager.start(); // 到期时刻 = 2026-11-21 00:24
  h.setNow(new Date(2026, 10, 21, 0, 30, 0).getTime()); // tick 迟到，且已跨天
  h.tick();
  assert.equal(h.days["2026-11-21"]?.focusMinutes, 25);
  assert.equal(h.days["2026-11-20"], undefined);
  assert.equal(h.sessions[0].date, "2026-11-21");
  assert.equal(h.manager.state().completed, 1);
});

test("pomodoro：检测到另一存活实例则禁用，心跳过期则正常接管", () => {
  const now = new Date(2026, 10, 20, 9, 0, 0).getTime();
  const saved: PersistedPomodoro = {
    mode: "focus",
    remaining: 100,
    running: false,
    completed: 0,
    savedAt: now - 5000,
    instanceId: "other-instance",
    heartbeatAt: now - 5000, // 5s 前有心跳 → 存活
  };
  const h = pomodoroHarness(saved, now);
  assert.equal(h.manager.state().disabled, true);
  h.manager.start();
  assert.equal(h.manager.state().running, false); // 禁用后不可启动
  assert.equal(h.store.data.pomodoro?.instanceId, "other-instance"); // 不覆盖对方状态

  const stale = pomodoroHarness({ ...saved, heartbeatAt: now - 120_000 }, now);
  assert.equal(stale.manager.state().disabled, false); // 心跳过期 → 接管
  assert.notEqual(stale.store.data.pomodoro?.instanceId, "other-instance"); // 接管立即写入本实例标识
  assert.equal(stale.store.data.pomodoro?.heartbeatAt, now); // 心跳立即刷新，接管窗口近零
});

/** memo 行为测试桩：内存 vault + 现有 Obsidian 桩。 */
function memoHarness() {
  const contents = new Map<string, string>();
  const files = new Map<string, TFile>();
  const fileFor = (path: string): TFile => {
    let file = files.get(path);
    if (!file) {
      file = new newTFile(path);
      files.set(path, file);
    }
    return file;
  };
  const vault = {
    getAbstractFileByPath: (path: string) =>
      contents.has(path) || files.has(path) ? fileFor(path) : null,
    read: async (file: TFile) => contents.get(file.path) ?? "",
    create: async (path: string, data: string) => {
      contents.set(path, data);
      return fileFor(path);
    },
    modify: async (file: TFile, data: string) => {
      contents.set(file.path, data);
    },
    process: async (file: TFile, fn: (data: string) => string) => {
      const next = fn(contents.get(file.path) ?? "");
      contents.set(file.path, next);
      return next;
    },
    createFolder: async (path: string) => {
      fileFor(path);
    },
  };
  const memos: MemoRecord[] = [];
  const store = {
    data: { memos },
    settings: settings(),
    addMemo: (memo: MemoRecord) => {
      memos.unshift(memo);
    },
    scheduleSave: () => {},
  };
  const plugin = { app: { vault }, store };
  const manager = new MemoManager(plugin as unknown as SedimentPlugin);
  return { manager, contents, memos };
}

test("memo：id 锚点兜底——日记正文被手动改过后编辑仍同步且不留孤儿", async () => {
  const h = memoHarness();
  const memo = await h.manager.add("original line", ["a"]);
  assert.ok(memo);
  const path = `daily/${dateKey(new Date())}.md`;
  const before = h.contents.get(path) ?? "";
  assert.ok(before.includes(`%%memo:${memo.id}%%`)); // 写入时带行内 id 锚点

  // 用户手动改了日记正文：旧文本匹配失配，id 锚点兜底
  h.contents.set(path, before.replace("> original line", "> manually edited"));
  const updated = await h.manager.edit(memo.id, "brand new text");
  assert.equal(updated?.text, "brand new text");
  const after = h.contents.get(path) ?? "";
  assert.ok(after.includes("> brand new text"));
  assert.ok(!after.includes("manually edited")); // 不留孤儿正文
  assert.ok(!after.includes("> original line"));
});

test("memo：删除失配尽力按旧文本清理，彻底失配时明确提示", async () => {
  const h = memoHarness();
  const path = `daily/${dateKey(new Date())}.md`;

  // 场景 1：锚点被手动删掉但正文还在 → 旧文本兜底清理成功
  const legacy = await h.manager.add("legacy body");
  assert.ok(legacy);
  h.contents.set(
    path,
    (h.contents.get(path) ?? "").replace(` %%memo:${legacy.id}%%`, "")
  );
  assert.equal(await h.manager.remove(legacy.id), true);
  assert.ok(!(h.contents.get(path) ?? "").includes("legacy body"));

  // 场景 2：锚点与正文都被改掉 → 无法定位，删除记录但明确提示
  const orphan = await h.manager.add("to be removed");
  assert.ok(orphan);
  h.contents.set(
    path,
    (h.contents.get(path) ?? "")
      .replace(`%%memo:${orphan.id}%%`, "")
      .replace("> to be removed", "> rewritten by hand")
  );
  noticeMessages.length = 0;
  assert.equal(await h.manager.remove(orphan.id), true);
  assert.equal(h.memos.length, 0);
  assert.ok(noticeMessages.some((message) => message.includes("未找到日记中对应条目")));
});

test("main：generateReview 文件已含本周区间标题时去重跳过", async () => {
  const store = {
    settings: settings(),
    data: { memos: [] as MemoRecord[] },
    getDay: () => createEmptyDay(),
  };
  const markdown = buildWeeklyReview(store as unknown as Store, new Date());
  const heading = markdown.split("\n", 1)[0];
  const weekStart = startOfWeek(new Date(), store.settings.weekStart);
  const path = `${normalizeFolder(store.settings.reviewFolder)}/复盘 ${dateKey(weekStart)}.md`;
  const file = new newTFile(path);
  let previousContent = `# 旧复盘\n\n${heading}\n\n正文`;
  let modifyCalls = 0;
  let opened: unknown = null;
  const fakePlugin = {
    store,
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p === path ? file : null),
        createFolder: async () => {},
        read: async () => previousContent,
        modify: async () => {
          modifyCalls += 1;
        },
        create: async () => {
          throw new Error("不应新建文件");
        },
      },
      workspace: {
        getLeaf: () => ({
          openFile: async (f: unknown) => {
            opened = f;
          },
        }),
      },
    },
  };
  const generateReview = (
    SedimentPlugin.prototype as unknown as { generateReview(this: unknown): Promise<void> }
  ).generateReview;

  noticeMessages.length = 0;
  await generateReview.call(fakePlugin);
  assert.equal(modifyCalls, 0); // 不再无限堆叠
  assert.equal(opened, file); // 直接打开已有复盘
  assert.ok(noticeMessages.includes("本周复盘已存在"));

  // 不含本周标题（上周复盘）时仍正常追加
  previousContent = "# 上周复盘\n\n旧内容";
  await generateReview.call(fakePlugin);
  assert.equal(modifyCalls, 1);
});

// ── Task 7：页签契约与设置 IA（审核队列纯函数口径 + 设置分区数据） ──

test("reviewBadgeCount：徽章=草稿+变更+待审写入之和，为 0 或非法输入不显示", () => {
  assert.equal(reviewBadgeCount({ drafts: 2, changes: 3, pendingWrites: 4 }), 9);
  assert.equal(reviewBadgeCount({ drafts: 0, changes: 0, pendingWrites: 0 }), 0);
  assert.equal(reviewBadgeCount({ drafts: 1 }), 1); // 缺字段按 0 计
  assert.equal(reviewBadgeCount(null), 0);
  assert.equal(reviewBadgeCount(undefined), 0);
  assert.equal(reviewBadgeCount({ drafts: -1, changes: 2, pendingWrites: 0 }), 0); // 不渲染负数徽章
});

test("filterAgentTasks：只保留速记委派的 Agent 子集，笔记原生待办不混入", () => {
  const tasks = [
    { path: "daily/2026-11-20.md", line: 3, text: "人类待办", date: "2026-11-20", checked: false },
    { path: "", line: 0, text: "Agent 待办", date: "2026-11-20", checked: false, memoId: "m1" },
    { path: "notes/x.md", line: 1, text: "带来源路径的笔记待办", date: "2026-11-19", checked: false, memoId: "m2" },
  ];
  const agent = filterAgentTasks(tasks);
  assert.deepEqual(agent.map((task) => task.text), ["Agent 待办"]);
  assert.equal(filterAgentTasks([]).length, 0);
});

test("pendingReviewChanges：POST 去重 + 仅 md/json + 排除已审查，徽章与卡片同口径", () => {
  const calls = [
    { time: "2026-11-20T10:00:00.000Z", tool: "POST patch_note", agent: "a", path: "n.md" },
    { time: "2026-11-20T09:00:00.000Z", tool: "POST write_note", agent: "a", path: "n.md" }, // 同路径去重
    { time: "2026-11-20T08:00:00.000Z", tool: "GET read_note", agent: "a", path: "r.md" }, // 读调用不待审
    { time: "2026-11-20T07:00:00.000Z", tool: "POST write_note", agent: "a", path: "img.png" }, // 非 md/json
    { time: "2026-11-20T06:00:00.000Z", tool: "POST write_note", agent: "a", path: "done.json" },
    { time: "2026-11-20T05:00:00.000Z", tool: "POST write_note", agent: "a", path: "" }, // 无路径
  ];
  const reviewed = { "2026-11-20T06:00:00.000Z|done.json": "kept" as const };
  const pending = pendingReviewChanges(calls, reviewed);
  assert.deepEqual(pending.map((call) => call.path), ["n.md"]);
  assert.equal(reviewBadgeCount({ drafts: 0, changes: pending.length, pendingWrites: 0 }), 1);
});

test("SETTINGS_SECTIONS：基础区置顶，Agent 目录/黑名单归 Agent 区，键跨区不重复", () => {
  assert.equal(SETTINGS_SECTIONS[0].id, "basics");
  assert.ok(SETTINGS_SECTIONS[0].keys.includes("language"));
  const agent = settingsSection("agent");
  for (const key of ["workLogFolder", "knowledgeFolder", "knowledgeCategories", "deniedFolders", "deniedTags"]) {
    assert.ok(agent.keys.includes(key), `${key} 应归入 Agent 区`);
    assert.ok(!SETTINGS_SECTIONS[0].keys.includes(key), `${key} 不应留在基础区`);
  }
  assert.ok(!agent.keys.includes("agentAllowDelete")); // 死开关已从设置 UI 移除
  assert.deepEqual(settingsSection("backup").keys, ["backupEnabled", "backupFolder", "backupKeep"]);
  const all = SETTINGS_SECTIONS.flatMap((section) => section.keys);
  assert.equal(new Set(all).size, all.length); // 无一键跨区重复
  assert.throws(() => settingsSection("不存在"));
});

// ── Task 8：i18n 防再犯扫描器自测 ──

test("lint-i18n：构造违规样本——createEl text 未包裹的中文字面量能被抓到", () => {
  const source = 'contentEl.createEl("h2", { text: "诊断日志" });';
  const violations = findViolations(source, "sample.ts");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 1);
  assert.equal(violations[0].key, "text");
  assert.match(violations[0].snippet, /诊断日志/);
});

test("lint-i18n：t()/tf() 包裹与多行对象写法放行", () => {
  const source = [
    'el.createDiv({ cls: "sd-x", text: t("中文") });',
    "el.createSpan({",
    '  cls: "sd-y",',
    '  text: tf("已记录 {n} 条", { n: 3 }),',
    "});",
    'el.createEl("button", { text: t("取消") });',
  ].join("\n");
  assert.deepEqual(findViolations(source), []);
});

test("lint-i18n：注释中的中文不视为违规，字符串内 // 不被误剥", () => {
  const source = [
    "// 中文行注释：诊断日志",
    "/* 中文块注释\n   第二行 */",
    'el.createDiv({ text: t("中文") }); // 尾随中文注释',
    'const url = "https://example.com/路径";',
    'el.createDiv({ text: url });',
  ].join("\n");
  assert.deepEqual(findViolations(source), []);
  const stripped = stripComments(source);
  assert.match(stripped, /https:\/\/example\.com\/路径/); // 字符串内容保留
  assert.equal(stripped.length, source.length); // 等长替换，行号不漂移
});

test("lint-i18n：模板字符串静态中文算违规，插值内 t() 不误报", () => {
  assert.equal(findViolations("el.createSpan({ text: `+${n} 行` });").length, 1);
  assert.equal(findViolations('el.createDiv({ text: `${t("近")} · ${x}` });').length, 0);
  assert.equal(findViolations('el.createDiv({ text: `Sediment ${v} · ${t("数据只留在本地")}` });').length, 0);
});

test("lint-i18n：?? 回退字面量与 cls 中文算违规；attr/placeholder 不在扫描范围", () => {
  assert.equal(findViolations('el.createEl("button", { text: label ?? "采用备份" });').length, 1);
  assert.equal(findViolations('el.createDiv({ cls: "中文类名" });').length, 1);
  // 范围控制（宁缺毋滥）：title/placeholder 等参数不在 text/cls 扫描口径内。
  assert.equal(findViolations('el.createDiv({ attr: { title: "中文提示" } });').length, 0);
  assert.equal(findViolations('el.createEl("input", { placeholder: "中文占位" });').length, 0);
});

test("lint-i18n：i18n-lint-allow 白名单（同行或上一行注释）放行", () => {
  assert.equal(findViolations('el.createDiv({ text: "中文" }); // i18n-lint-allow').length, 0);
  assert.equal(findViolations("// i18n-lint-allow\nel.createDiv({ text: \"中文\" });").length, 0);
  assert.equal(findViolations('el.createDiv({ text: "中文" });').length, 1);
});

test("lint-i18n C1：tf(`模板`) / t(`模板`) 首参模板字面量豁免，裸模板仍算违规", () => {
  assert.equal(findViolations("el.createDiv({ text: tf(`中文 {n}`, { n }) });").length, 0);
  assert.equal(findViolations("el.createDiv({ text: t(`中文`) });").length, 0);
  // 未被 t()/tf() 包裹的模板静态中文仍须被抓到。
  assert.equal(findViolations("el.createSpan({ text: `+${n} 行` });").length, 1);
});

test("lint-i18n C1：白名单 marker 落在字符串字面量内不得自我放行", () => {
  // marker 写进 text 字符串本身（而非注释）——剥离注释后仍在，不能豁免。
  assert.equal(findViolations('el.createDiv({ text: "中文 i18n-lint-allow" });').length, 1);
  // 同行既有注释 marker 又有字符串 marker 时，以注释为准放行。
  assert.equal(findViolations('el.createDiv({ text: "中文" }); // i18n-lint-allow').length, 0);
});

test("lint-i18n：违规行号定位准确（多行源码）", () => {
  const source = 'const a = 1;\n// 注释\nel.createDiv({\n  text: "中文",\n});';
  const violations = findViolations(source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 4);
});

// ── Task 8：图表可访问性（role/aria-label/图例标签） ──

test("charts：各 SVG 输出带 role=img 与汇总数值的 aria-label", () => {
  const prev = getLocale();
  try {
    setLocale("zh");
    assert.match(barChart([1, 5, 3]), /role="img"/);
    assert.match(barChart([1, 5, 3]), /aria-label="柱状图：3 项，峰值 5"/);
    assert.match(sparkline([2, 7, 4]), /role="img"/);
    assert.match(sparkline([2, 7, 4]), /峰值 7/);
    assert.match(ring(3, 4), /aria-label="环形进度：3 \/ 4"/);
    assert.match(goalRing(50, 200), /aria-label="目标进度：50 \/ 200，25%"/);
  } finally {
    setLocale(prev);
  }
});

test("charts：multiLine 系列标签进入 aria-label；无标签向后兼容", () => {
  const prev = getLocale();
  try {
    setLocale("zh");
    const labeled = multiLine([
      { values: [1, 5], color: "red", label: "新增" },
      { values: [2, 3], color: "gray", label: "移除" },
    ]);
    assert.match(labeled, /role="img"/);
    assert.match(labeled, /新增 峰值 5; 移除 峰值 3/);
    assert.equal((labeled.match(/<polyline /g) ?? []).length, 2);
    // 旧调用方（无 label）不破坏：仍输出 SVG，系列用兜底名。
    const legacy = multiLine([{ values: [1, 2], color: "red" }]);
    assert.match(legacy, /<svg class="sd-chart"/);
    assert.match(legacy, /系列 1 峰值 2/);
  } finally {
    setLocale(prev);
  }
});

test("charts：EN 环境 aria-label 输出英文", () => {
  const prev = getLocale();
  try {
    setLocale("en");
    assert.match(barChart([1, 5]), /aria-label="Bar chart: 2 items, peak 5"/);
    assert.match(
      multiLine([{ values: [4], color: "red", label: "Added" }]),
      /Line chart: Added peak 4/
    );
    assert.match(ring(1, 2), /Ring progress: 1 \/ 2/);
  } finally {
    setLocale(prev);
  }
});

test("charts：ariaLabel 可覆盖默认文案且属性值转义", () => {
  const svg = barChart([1], undefined, [], '自定义 "quoted" & <tag>');
  assert.match(svg, /aria-label="自定义 &quot;quoted&quot; &amp; &lt;tag&gt;"/);
  assert.doesNotMatch(svg, /柱状图/);
});

// ── Task 8：启动 Notice 语言顺序（Task 5 移交项） ──

test("localeFromPersisted：从持久化数据预读语言，非法/缺失回退 auto", () => {
  const prev = getLocale();
  try {
    assert.equal(localeFromPersisted({ settings: { language: "en" } }), "en");
    assert.equal(localeFromPersisted({ settings: { language: "zh" } }), "zh");
    // Node 环境无 window.moment，auto 探测兜底 zh。
    assert.equal(localeFromPersisted({ settings: { language: "auto" } }), "zh");
    assert.equal(localeFromPersisted({ settings: { language: "fr" } }), "zh");
    assert.equal(localeFromPersisted({ settings: {} }), "zh");
    assert.equal(localeFromPersisted({}), "zh");
    assert.equal(localeFromPersisted(null), "zh");
    assert.equal(localeFromPersisted("broken"), "zh");
    assert.equal(localeFromPersisted([1, 2]), "zh");
  } finally {
    setLocale(prev);
  }
});

test("Store.load：EN 预读顺序下启动迁移警告为英文（回归 main.ts onload 契约）", async () => {
  const prev = getLocale();
  try {
    const raw = { version: 99, settings: { language: "en" }, days: {} };
    // main.ts onload 现在先 setLocale(localeFromPersisted(loadData())) 再 store.load()。
    setLocale(localeFromPersisted(raw));
    const store = new Store({ loadData: async () => raw } as unknown as Parameters<typeof Store>[0]);
    await store.load();
    assert.match(store.migrationWarning ?? "", /Unsupported data version 99/);
    assert.doesNotMatch(store.migrationWarning ?? "", /不支持的数据版本/);
  } finally {
    setLocale(prev);
  }
});

test("Store.load：zh 预读顺序下迁移警告仍为中文", async () => {
  const prev = getLocale();
  try {
    const raw = { version: 99, settings: { language: "zh" } };
    setLocale(localeFromPersisted(raw));
    const store = new Store({ loadData: async () => raw } as unknown as Parameters<typeof Store>[0]);
    await store.load();
    assert.match(store.migrationWarning ?? "", /不支持的数据版本 99/);
  } finally {
    setLocale(prev);
  }
});

// ── Task 9：月度地层聚合（纯函数） ──

test("aggregateStrata：正常聚合——四类贡献按月求和（focus 取 days.focusMinutes）", () => {
  const source = {
    days: {
      "2026-01-05": day({ wordsAdded: 100, aiWordsAdded: 40, tasksCompleted: 2, focusMinutes: 25 }),
      "2026-01-20": day({ wordsAdded: 50, aiWordsAdded: 10, tasksCompleted: 1 }),
      "2026-02-03": day({ wordsAdded: 70, tasksCompleted: 3, focusMinutes: 25 }),
      "2026-02-10": day({ focusMinutes: 25 }),
    },
  };
  assert.deepEqual(aggregateStrata(source, { from: "2026-01", to: "2026-02" }), [
    { month: "2026-01", human: 150, agent: 50, tasks: 3, focus: 25 },
    { month: "2026-02", human: 70, agent: 0, tasks: 3, focus: 50 },
  ]);
});

test("aggregateStrata：空数据——范围内每月输出全 0，缺 source 字段不抛错", () => {
  assert.deepEqual(aggregateStrata({ days: {} }, { from: "2026-03", to: "2026-05" }), [
    { month: "2026-03", human: 0, agent: 0, tasks: 0, focus: 0 },
    { month: "2026-04", human: 0, agent: 0, tasks: 0, focus: 0 },
    { month: "2026-05", human: 0, agent: 0, tasks: 0, focus: 0 },
  ]);
  assert.deepEqual(aggregateStrata({}, { from: "2026-01", to: "2026-01" }), [
    { month: "2026-01", human: 0, agent: 0, tasks: 0, focus: 0 },
  ]);
});

test("aggregateStrata：跨月/跨年边界——月末月初归各自月份，范围外数据忽略", () => {
  const source = {
    days: {
      "2025-12-31": day({ wordsAdded: 10, tasksCompleted: 1, focusMinutes: 25 }),
      "2026-01-01": day({ wordsAdded: 20, aiWordsAdded: 5, focusMinutes: 50 }),
      "2026-02-15": day({ focusMinutes: 25 }),
      "2025-10-01": day({ wordsAdded: 999 }),
      "2026-03-01": day({ wordsAdded: 888 }),
    },
  };
  const result = aggregateStrata(source, { from: "2025-11", to: "2026-02" });
  assert.deepEqual(result.map((m) => m.month), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(result[0], { month: "2025-11", human: 0, agent: 0, tasks: 0, focus: 0 });
  assert.deepEqual(result[1], { month: "2025-12", human: 10, agent: 0, tasks: 1, focus: 25 });
  assert.deepEqual(result[2], { month: "2026-01", human: 20, agent: 5, tasks: 0, focus: 50 });
  assert.deepEqual(result[3], { month: "2026-02", human: 0, agent: 0, tasks: 0, focus: 25 });
});

test("aggregateStrata：缺字段/脏数据——null、NaN、负数、非法日键一律按 0 或跳过", () => {
  const source = {
    days: {
      "2026-01-01": { wordsAdded: 30, focusMinutes: Number.NaN },
      "2026-01-02": null,
      "2026-01-03": { wordsAdded: Number.NaN, aiWordsAdded: -5, tasksCompleted: "2" as unknown as number, focusMinutes: -25 },
      "2026-01-04": { wordsAdded: 10, aiWordsAdded: undefined, tasksCompleted: undefined, focusMinutes: undefined },
      "not-a-date": { wordsAdded: 100 },
      // B2：完整 YYYY-MM-DD 校验——月/日越界或不补零的键不得按月前缀混入归桶。
      "2026-1-05": { wordsAdded: 100, focusMinutes: 100 },
      "2026-01-5": { wordsAdded: 100, focusMinutes: 100 },
      "2026-01-00": { wordsAdded: 100, focusMinutes: 100 },
      "2026-01-32": { wordsAdded: 100, focusMinutes: 100 },
      "2026-13-01": { wordsAdded: 100, focusMinutes: 100 },
      "2026-00-01": { wordsAdded: 100, focusMinutes: 100 },
    },
  };
  assert.deepEqual(aggregateStrata(source, { from: "2026-01", to: "2026-01" }), [
    { month: "2026-01", human: 40, agent: 0, tasks: 2, focus: 0 },
  ]);
});

test("aggregateStrata：focus 层以 days.focusMinutes 为口径——不受 focusSessions 500 条截断影响", () => {
  // 重度用户场景：focusSessions 列表只保留最近 500 条（store.addFocusSession 截断），
  // 早期月份会话已被丢弃，但 days.focusMinutes 与番茄钟落账同源、永不截断。
  const source = {
    days: {
      "2026-01-01": day({ focusMinutes: 25 }),
      "2026-01-02": day({ focusMinutes: 50 }),
      "2026-01-03": day({ focusMinutes: 0 }),
    },
  };
  const [jan] = aggregateStrata(source, { from: "2026-01", to: "2026-01" });
  assert.equal(jan.focus, 75, "focus 层必须等于 days.focusMinutes 之和，而非（可能截断的）会话列表");
});

test("listMonths：非法格式或 reversed 范围返回空；单月范围含两端", () => {
  assert.deepEqual(listMonths({ from: "2026-01", to: "2026-03" }), ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(listMonths({ from: "2026-02", to: "2026-02" }), ["2026-02"]);
  assert.deepEqual(listMonths({ from: "2026-03", to: "2026-01" }), []);
  assert.deepEqual(listMonths({ from: "2026-13", to: "2027-01" }), []);
  assert.deepEqual(listMonths({ from: "2026-00", to: "2026-02" }), []);
  assert.deepEqual(listMonths({ from: "2026-1", to: "2026-02" }), []);
  assert.deepEqual(aggregateStrata({ days: {} }, { from: "bad", to: "2026-01" }), []);
});

test("recentStrataRange：最近 n 个月含当月，跨年正确，n<1 兜底 1", () => {
  assert.deepEqual(recentStrataRange(12, new Date(2026, 0, 15)), { from: "2025-02", to: "2026-01" });
  assert.deepEqual(recentStrataRange(3, new Date(2026, 10, 20)), { from: "2026-09", to: "2026-11" });
  assert.deepEqual(recentStrataRange(1, new Date(2026, 5, 1)), { from: "2026-06", to: "2026-06" });
  assert.deepEqual(recentStrataRange(0, new Date(2026, 5, 1)), { from: "2026-06", to: "2026-06" });
});

test("aggregateStrata：纯函数——不修改输入数据", () => {
  const source = {
    days: { "2026-01-01": day({ wordsAdded: 10, focusMinutes: 25 }) },
  };
  const snapshot = JSON.stringify(source);
  aggregateStrata(source, { from: "2026-01", to: "2026-02" });
  assert.equal(JSON.stringify(source), snapshot);
});

// ── Task 10 第一轮：代码加固 ─────────────────────────────────────────────

test("A1：addMemo/delegateTask 的日记目标路径过完整门禁（黑名单/白名单/confirm 前置）", async () => {
  // auto 档 + 黑名单 daily：速记与转 Agent 都必须 403，且不产生任何副作用。
  const denied = fakeAgentPlugin({ deniedFolders: "daily" }, { data: { memos: [] } });
  await assert.rejects(denied.api.addMemo("灵感", []), (error) => {
    const apiError = asApiError(error);
    assert.equal(apiError.code, "FORBIDDEN");
    assert.match(apiError.message, /daily/);
    return true;
  });
  await assert.rejects(denied.api.delegateTask("notes/a.md", 2), (error) => asApiError(error).code === "FORBIDDEN");
  assert.equal(denied.calls.delegate.length, 0, "越权不得触达 tasks.delegate");

  // 白名单不含 daily：fail-closed，同样 403。
  const allowlist = fakeAgentPlugin({ agentAccessMode: "allowlist", agentAllowedFolders: "知识", agentAllowRead: true });
  await assert.rejects(allowlist.api.addMemo("灵感", []), (error) => asApiError(error).code === "FORBIDDEN");

  // confirm 档：门禁先于挂起，越权不产生待审项。
  const confirm = fakeConfirmPlugin({ agentWorkMode: "confirm", deniedFolders: "daily" });
  await assert.rejects(confirm.api.addMemo("灵感", []), (error) => asApiError(error).code === "FORBIDDEN");
  assert.equal(confirm.pendingWrites.length, 0, "越权速记不得转挂起");

  // 默认设置（daily 可写）不受影响：confirm 挂起、bypass 直通。
  const ok = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const held = (await ok.api.addMemo("灵感一条", ["idea"])) as HoldResult;
  assert.ok(pendingIdOf(held));
  const direct = fakeAgentPlugin({}, { plugin: { memos: { add: async () => ({ id: "m1" }) } } });
  await assert.doesNotReject(direct.api.addMemo("灵感", [], undefined, undefined, true));
});

test("A1：confirm 采纳重放同样过门禁——挂起后收紧黑名单则采纳被拒且保留待审项", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const held = (await ctx.api.addMemo("灵感一条", [])) as HoldResult;
  const id = pendingIdOf(held);
  // 挂起之后用户收紧权限：重放必须按当前设置重新校验，而不是信任挂起时的快照。
  ctx.store.settings.deniedFolders = "daily";
  await assert.rejects(ctx.api.approvePendingWrite(id), (error) => asApiError(error).code === "FORBIDDEN");
  assert.equal(ctx.pendingWrites.length, 1, "重放失败不得丢弃待审项");
  assert.equal(ctx.store.data.memos.length, 0, "重放被拒不得落盘");
});

test("A2：delegateTask 目标行不存在返回 404 NOT_FOUND；load 过滤 args 畸形的 pendingWrites", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "- [ ] 真实任务\n" });
  await assert.rejects(ctx.api.delegateTask("notes/a.md", 99), (error) => {
    const apiError = asApiError(error);
    assert.equal(apiError.code, "NOT_FOUND");
    assert.equal(apiError.status, 404);
    assert.match(apiError.message, /找不到待办：notes\/a\.md:99/);
    return true;
  });
  assert.equal(ctx.pendingWrites.length, 0, "404 不得转挂起");

  // 迁移过滤：args 非对象（null/字符串/数组/缺失）的条目会让采纳重放抛裸 TypeError，load 时剔除。
  const valid = {
    id: "ok-1", path: "notes/a.md", tool: "write_note",
    request: { kind: "write_note", args: { path: "notes/a.md", content: "x", mode: "create" } },
  };
  const raw = {
    version: 1,
    pendingWrites: [
      valid,
      { ...valid, id: "bad-null", request: { kind: "write_note", args: null } },
      { ...valid, id: "bad-str", request: { kind: "write_note", args: "oops" } },
      { ...valid, id: "bad-missing", request: { kind: "write_note" } },
      { ...valid, id: "bad-array", request: { kind: "write_note", args: [1] } },
      "not-an-object",
    ],
  };
  const { vault } = fakeVault();
  const { plugin } = fakePluginWith(vault, raw);
  const store = new Store(plugin);
  await store.load();
  assert.deepEqual(store.data.pendingWrites.map((item) => item.id), ["ok-1"]);
});

test("A3：restoreDataBackup 三态语义——此前无数据 none / 副本写失败 failed 不静默", async () => {
  const backupName = "data-2026-11-19-0800.json";
  const backupContent = JSON.stringify({ version: 1, days: { "2026-11-19": { wordsAdded: 42 } }, memos: [] });

  // 全新安装（loadData 为 null）：无需恢复副本，明确返回 none 而非歧义空串。
  const fresh = fakeVault([{ path: `sediment-backup/${backupName}`, mtime: 200, size: backupContent.length }]);
  fresh.written.push([`sediment-backup/${backupName}`, backupContent]);
  const freshCtx = fakePluginWith(fresh.vault, null);
  const freshStore = new Store(freshCtx.plugin);
  await freshStore.load();
  const none = await freshStore.restoreDataBackup(backupName);
  assert.deepEqual(none, { recoveryPath: "", recovery: "none" });
  assert.equal(freshStore.getDay("2026-11-19").wordsAdded, 42, "none 分支仍须完成恢复");

  // 副本写失败：恢复继续，但必须显式标记 failed 并留下诊断（不静默吞错）。
  const failing = fakeVault([{ path: `sediment-backup/${backupName}`, mtime: 200, size: backupContent.length }]);
  failing.written.push([`sediment-backup/${backupName}`, backupContent]);
  const failCtx = fakePluginWith(failing.vault, { version: 1, days: {} });
  const failStore = new Store(failCtx.plugin);
  await failStore.load();
  failing.vault.adapter.write = async () => { throw new Error("permission denied"); };
  // 恢复完成后 load() 会以备份内容重建 diagnostics，故用 spy 断言失败当时已记录。
  const diagnosticCalls: string[] = [];
  const originalLog = failStore.logDiagnostic.bind(failStore);
  failStore.logDiagnostic = (category: string, message: string, detail?: string, schedule?: boolean) => {
    diagnosticCalls.push(message);
    originalLog(category, message, detail, schedule);
  };
  const originalError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  let failed: Awaited<ReturnType<Store["restoreDataBackup"]>>;
  try {
    failed = await failStore.restoreDataBackup(backupName);
  } finally {
    console.error = originalError;
  }
  assert.equal(failed!.recovery, "failed");
  assert.equal(failed!.recoveryPath, "");
  assert.ok(logged > 0, "副本失败必须 console.error");
  assert.ok(diagnosticCalls.some((m) => m.includes("恢复副本创建失败")), "副本失败必须进诊断列表");
  assert.equal(failStore.getDay("2026-11-19").wordsAdded, 42, "failed 分支仍须完成恢复");
});

test("A4：保存持续失败时 Notice 60 秒节流，console 与诊断每次都记", async () => {
  const { vault } = fakeVault();
  const plugin = {
    loadData: async () => null,
    saveData: async () => { throw new Error("disk full"); },
    app: { vault },
  } as unknown as Parameters<typeof Store>[0];
  const store = new Store(plugin);
  await store.load();
  noticeMessages.length = 0;
  const originalError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  try {
    await store.save();
    await store.save();
    await store.save();
  } finally {
    console.error = originalError;
  }
  assert.equal(logged, 3, "每次失败都要 console.error + 诊断");
  assert.equal(store.data.diagnostics.filter((d) => d.message.includes("保存 data.json 失败")).length, 3);
  assert.equal(noticeMessages.filter((m) => m.includes("数据保存失败")).length, 1, "60 秒窗口内只弹一次 Notice");
});

test("第 7 项：logError——console.error + 诊断 sink（不触发调度保存），sink 缺失不抛", () => {
  const records: Array<{ category: string; message: string; detail?: string; schedule?: boolean }> = [];
  const sink = {
    logDiagnostic: (category: string, message: string, detail?: string, schedule?: boolean) => {
      records.push({ category, message, detail, schedule });
    },
  };
  const originalError = console.error;
  let logged = 0;
  console.error = () => { logged += 1; };
  try {
    logError(sink, "保存失败", new Error("disk full"), "storage");
    logError(null, "启动早期错误", "boom");
    logError(undefined, "启动早期错误 2", new Error("x"), "migration");
  } finally {
    console.error = originalError;
  }
  assert.equal(logged, 3);
  assert.equal(records.length, 1);
  assert.equal(records[0].category, "storage");
  assert.equal(records[0].message, "保存失败");
  assert.equal(records[0].detail, "disk full");
  assert.equal(records[0].schedule, false, "失败路径不得再触发调度保存，避免保存风暴");
});

test("第 5 项：sanitizeServerError——业务错误白名单透传，内部错误脱敏", () => {
  assert.equal(sanitizeServerError(new Error("笔记已存在：a.md")), "笔记已存在：a.md");
  assert.equal(sanitizeServerError(new Error("版本冲突：a.md 已被修改")), "版本冲突：a.md 已被修改");
  assert.equal(sanitizeServerError(new Error("访问被拒绝：daily/x.md")), "访问被拒绝：daily/x.md");
  assert.equal(sanitizeServerError(new Error("速记 m1 不是待办任务")), "速记 m1 不是待办任务");
  const masked = sanitizeServerError(new Error("ENOENT: /home/user/secret/data.json"));
  assert.ok(!masked.includes("/home/user"), "内部错误不得泄漏路径等细节");
  assert.match(masked, /内部错误/);
  assert.match(sanitizeServerError("裸字符串错误"), /内部错误/);
});

/** 原生 socket 发一条 HTTP 请求并收完整响应（Connection: close 保证 end 触发）。 */
function rawHttp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    socket.on("data", (chunk) => { data += String(chunk); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("raw http timeout")));
  });
}

test("第 5 项：AgentServer HTTP 契约——仅 Authorization 头鉴权、?token= 失效、413、400 非法 URL", async () => {
  const port = 28653;
  const diagnostics: Array<{ category: string; message: string }> = [];
  const plugin = {
    store: {
      settings: { agentServerEnabled: true, agentServerPort: port, agentServerToken: "unit-token" },
      logDiagnostic: (category: string, message: string) => { diagnostics.push({ category, message }); },
    },
    agentApi: { logToolCall: () => {}, setCallContext: () => {} },
    manifest: { version: "0.9.7" },
  } as unknown as ConstructorParameters<typeof AgentServer>[0];
  const server = new AgentServer(plugin);
  await server.applySettings();
  try {
    const host = "Host: 127.0.0.1\r\nConnection: close\r\n";
    // 无令牌 → 401，并记安全诊断。
    const noToken = await rawHttp(port, `GET /health HTTP/1.1\r\n${host}\r\n`);
    assert.match(noToken, /^HTTP\/1\.1 401/);
    assert.ok(diagnostics.some((d) => d.category === "security" && d.message.includes("鉴权失败")));

    // ?token= 查询串已移除：即使值正确也 401（避免令牌落入日志/代理缓存）。
    const queryToken = await rawHttp(port, `GET /health?token=unit-token HTTP/1.1\r\n${host}\r\n`);
    assert.match(queryToken, /^HTTP\/1\.1 401/);

    // Authorization: Bearer 头 → 200。
    const headerToken = await rawHttp(port, `GET /health HTTP/1.1\r\n${host}Authorization: Bearer unit-token\r\n\r\n`);
    assert.match(headerToken, /^HTTP\/1\.1 200/);
    assert.match(headerToken, /"ok":true/);

    // 非法请求 URL → 400 INVALID_URL，而不是未捕获异常断连。
    const badUrl = await rawHttp(port, `GET //[bad HTTP/1.1\r\n${host}\r\n`);
    assert.match(badUrl, /^HTTP\/1\.1 400/);
    assert.match(badUrl, /INVALID_URL/);

    // 超过 1MB 的请求体 → 413 PAYLOAD_TOO_LARGE。
    const body = JSON.stringify({ path: "a.md", content: "x".repeat(1_100_000) });
    const tooLarge = await rawHttp(
      port,
      `POST /note HTTP/1.1\r\n${host}Authorization: Bearer unit-token\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    );
    assert.match(tooLarge, /^HTTP\/1\.1 413/);
    assert.match(tooLarge, /PAYLOAD_TOO_LARGE/);
  } finally {
    await server.stop();
  }
});

test("第 5 项：MCP 桥接源——令牌走 Authorization 头、缺令牌报错、超时与缓冲上限齐备", () => {
  assert.ok(BRIDGE_SOURCE.includes("Authorization: `Bearer ${TOKEN}`"), "令牌必须走 Authorization 头");
  assert.ok(!BRIDGE_SOURCE.includes('searchParams.set("token"'), "不得再把令牌拼进查询串");
  assert.ok(BRIDGE_SOURCE.includes("缺少令牌"), "缺 SEDIMENT_TOKEN 必须显式报错而非静默匿名请求");
  assert.ok(BRIDGE_SOURCE.includes("REQUEST_TIMEOUT_MS"), "HTTP 请求必须有超时");
  assert.ok(BRIDGE_SOURCE.includes("MAX_RESPONSE_CHARS"), "响应体必须有大小上限");
  assert.ok(BRIDGE_SOURCE.includes("MAX_STDIN_BUFFER_CHARS"), "stdin 缓冲必须有上限");
  assert.ok(BRIDGE_SOURCE.includes("畸形 JSON"), "畸形 JSON 输入必须显式报错");
});

test("B3：escapeAttr 导出复用——& < > 双引号全量转义", () => {
  assert.equal(escapeAttr('a&b<c>d"e'), "a&amp;b&lt;c&gt;d&quot;e");
  assert.equal(escapeAttr(""), "");
});

// ---------------------------------------------------------------------------
// Task 10 第二轮：清理 / 文档 / 工具（C2 嵌入文案、C3 EN 月份补零）
// ---------------------------------------------------------------------------

test("C2：embed.todayLine 中英文走 tf()，EN 不再泄漏中文", async () => {
  const { vault } = fakeVault();
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();
  const key = dateKey(new Date());
  store.data.days[key] = day({ contribution: 12, wordsAdded: 340, notesCreated: 2 });
  store.data.memos = [{ date: key } as unknown as MemoRecord];
  const prev = getLocale();
  try {
    setLocale("zh");
    assert.equal(todayLine(store), "贡献 12 分 · 新增 340 字 · 新建 2 篇 · 速记 1 条");
    setLocale("en");
    assert.equal(todayLine(store), "Contrib 12 pts · 340 words added · 2 notes created · 1 memos");
  } finally {
    setLocale(prev);
  }
});

test("C3：EN 月份模板 {year}-{month} 配合补零月份输出 ISO 年月", () => {
  const prev = getLocale();
  try {
    setLocale("en");
    // 海报标题调用方现在传补零月份字符串，EN 渲染为 2026-01 而非 2026-1。
    assert.equal(tf("{year} 年 {month} 月", { year: 2026, month: "01" }), "2026-01");
    assert.equal(tf("{year} 年 {month} 月", { year: 2026, month: "12" }), "2026-12");
    setLocale("zh");
    assert.equal(tf("{year} 年 {month} 月", { year: 2026, month: "01" }), "2026 年 01 月");
  } finally {
    setLocale(prev);
  }
});

// ---------------------------------------------------------------------------
// 全分支终审单轮修复：claim/complete 日记门禁、recordWorkLog/snapshotTasks
// 按存在性选操作、年轮图 i18n 与可访问性
// ---------------------------------------------------------------------------

/** 往 fakeConfirmPlugin 里塞一条当天 #to-agent 速记，返回该 memo 供副作用断言。 */
function seedAgentMemo(ctx: ReturnType<typeof fakeConfirmPlugin>) {
  const memo = {
    id: "m1", date: dateKey(new Date()), time: "00:00", text: "任务",
    tags: ["to-agent"], converted: false,
  };
  ctx.store.data.memos.push(memo);
  return memo;
}

test("终审 1：claimAgentTask/completeAgentTask 日记路径过 patch 门禁；人用 bypass 面不受影响", async () => {
  // 黑名单含日记目录：Agent claim/complete 都 403，零落盘（标签不动、syncTags 不触达）。
  const denied = fakeConfirmPlugin({ agentWorkMode: "auto", deniedFolders: "daily" });
  let syncCalls = 0;
  denied.plugin.memos.syncTags = async () => { syncCalls += 1; };
  const memo = seedAgentMemo(denied);
  await assert.rejects(denied.api.claimAgentTask("m1"), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN" && e.status === 403 && /daily/.test(e.message);
  });
  await assert.rejects(denied.api.completeAgentTask("m1"), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN" && e.status === 403;
  });
  assert.equal(syncCalls, 0, "被拒时不得触达 memos.syncTags");
  assert.deepEqual(memo.tags, ["to-agent"], "被拒时不得改标签");
  assert.equal(memo.converted, false, "被拒时不得标记完成");
  assert.equal(denied.files.size, 0, "零落盘");

  // readonly 档：patch 操作被拒（403 OPERATION_DENIED）。
  const ro = fakeConfirmPlugin({
    agentWorkMode: "readonly",
    agentAllowRead: true, agentAllowCreate: false, agentAllowPatch: false, agentAllowOverwrite: false,
  });
  seedAgentMemo(ro);
  await assert.rejects(ro.api.claimAgentTask("m1"), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && e.status === 403 && /readonly 模式拒绝写入/.test(e.message);
  });
  await assert.rejects(ro.api.completeAgentTask("m1"), (error) => asApiError(error).code === "OPERATION_DENIED");

  // allowlist 不含日记目录：fail-closed，同样 403。
  const allowlist = fakeConfirmPlugin({ agentWorkMode: "auto", agentAccessMode: "allowlist", agentAllowedFolders: "知识" });
  seedAgentMemo(allowlist);
  await assert.rejects(allowlist.api.claimAgentTask("m1"), (error) => asApiError(error).code === "FORBIDDEN");

  // 人用看板调用面（bypassAccess=true）：readonly + 黑名单下照常认领/完成。
  const human = fakeConfirmPlugin({
    agentWorkMode: "readonly", deniedFolders: "daily",
    agentAllowRead: true, agentAllowCreate: false, agentAllowPatch: false, agentAllowOverwrite: false,
  });
  let humanSync = 0;
  human.plugin.memos.syncTags = async () => { humanSync += 1; };
  seedAgentMemo(human);
  const claimed = await human.api.claimAgentTask("m1", true);
  assert.deepEqual(claimed.tags, ["agent-in-progress"]);
  const done = await human.api.completeAgentTask("m1", "知识/产出.md", true);
  assert.deepEqual(done.tags, ["agent-done"]);
  assert.equal(done.converted, true);
  assert.equal(done.resultPath, "知识/产出.md");
  assert.equal(humanSync, 2, "人用面两次操作都正常同步日记标签");
});

test("终审 2：recordWorkLog 目标已存在按 patch 过门禁——draft 档第二次被拒且不改动既有日志", async () => {
  const draftFlags = { agentAllowRead: true, agentAllowCreate: true, agentAllowPatch: false, agentAllowOverwrite: false };
  const ctx = fakeConfirmPlugin({ agentWorkMode: "draft", ...draftFlags });
  const first = (await ctx.api.recordWorkLog({ task: "t1", summary: "第一条" })) as HoldResult;
  assert.equal(first.pending, undefined, "draft 档首条直接新建落盘");
  const logPath = `agent-logs/${dateKey(new Date())}.md`;
  const content = ctx.files.get(logPath);
  assert.ok(content?.includes("第一条"));

  await assert.rejects(ctx.api.recordWorkLog({ task: "t2", summary: "第二条" }), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && e.status === 403;
  });
  assert.equal(ctx.files.get(logPath), content, "被拒的追加不得改动既有日志");
  assert.equal(ctx.store.data.workLogs.length, 1, "被拒条目不得入库");

  // confirm 档同步：首条挂起（create 门禁），采纳落盘后第二条按 patch 门禁被拒、不转挂起。
  const confirm = fakeConfirmPlugin({ agentWorkMode: "confirm", ...draftFlags });
  const held = (await confirm.api.recordWorkLog({ task: "t1", summary: "s" })) as HoldResult;
  await confirm.api.approvePendingWrite(pendingIdOf(held));
  assert.ok(confirm.files.has(logPath), "采纳后日志已落盘");
  await assert.rejects(confirm.api.recordWorkLog({ task: "t2", summary: "s2" }), (error) => asApiError(error).code === "OPERATION_DENIED");
  assert.equal(confirm.pendingWrites.length, 0, "门禁先于挂起：被拒的第二条不产生待审项");
});

test("终审 3：snapshotTasks 日记缺失按 create 过门禁——patch=true/create=false 不得凭空建日记", async () => {
  const files = { "notes/a.md": "- [ ] 遗留任务\n" };
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto", agentAllowCreate: false, agentAllowPatch: true }, files);
  const dailyPath = dailyNotePath(ctx.store.settings, new Date());
  await assert.rejects(ctx.api.snapshotTasks(), (error) => {
    const e = asApiError(error);
    return e.code === "OPERATION_DENIED" && e.status === 403;
  });
  assert.equal(ctx.files.has(dailyPath), false, "被拒时不得新建日记");

  // confirm 档同样：门禁先于挂起，不产生待审项。
  const confirm = fakeConfirmPlugin({ agentWorkMode: "confirm", agentAllowCreate: false, agentAllowPatch: true }, files);
  await assert.rejects(confirm.api.snapshotTasks(), (error) => asApiError(error).code === "OPERATION_DENIED");
  assert.equal(confirm.pendingWrites.length, 0);

  // 日记已存在：按 patch 过门禁，create=false 不影响追加。
  const existing = fakeConfirmPlugin(
    { agentWorkMode: "auto", agentAllowCreate: false, agentAllowPatch: true },
    { ...files, [dailyPath]: "# 今天\n" }
  );
  const res = (await existing.api.snapshotTasks()) as HoldResult & { count: number };
  assert.equal(res.count, 1);
  assert.ok(String(existing.files.get(dailyPath)).includes("遗留任务"));

  // create 允许时缺日记照常新建（不破坏既有行为）。
  const ok = fakeConfirmPlugin({ agentWorkMode: "auto" }, files);
  const okRes = (await ok.api.snapshotTasks()) as HoldResult & { count: number };
  assert.equal(okRes.count, 1);
  assert.ok(ok.files.has(dailyNotePath(ok.store.settings, new Date())));
});

test("终审 4：年轮图月份标签走 tf()（EN 无中文泄漏），SVG 带 role=img 与 aria-label", () => {
  const year = new Date().getFullYear();
  const days: Record<string, DayRecord> = { [`${year}-01-05`]: day({ contribution: 4 }) };
  const html: string[] = [];
  const slot = {
    set innerHTML(value: string) { html.push(value); },
    get innerHTML() { return html[html.length - 1] ?? ""; },
  };
  const card = { setAttribute: () => {}, querySelector: () => undefined, createDiv: () => slot };
  const view = {
    yearlyTab: "wheel",
    analyticsCard: () => card,
    render: () => {},
    plugin: { store: { data: { days }, getDay: (key: string) => days[key] ?? createEmptyDay() } },
  };
  const prev = getLocale();
  try {
    setLocale("zh");
    renderYearly(view as never, {} as never);
    const zh = html[0];
    assert.ok(zh.includes(">1月<") && zh.includes(">12月<"), "ZH 月份标签保持 {n}月 口径");
    assert.match(zh, /role="img"/, "年轮 SVG 必须带 role=img");
    assert.match(zh, /aria-label="[^"]*年轮/, "aria-label 复用指纹图同款转义口径");
    setLocale("en");
    renderYearly(view as never, {} as never);
    const en = html[1];
    assert.ok(!/[\u4e00-\u9fff]/.test(en), "EN 年轮不得泄漏中文");
    assert.match(en, /aria-label="[^"]*Year wheel/);
    assert.ok(en.includes(">1<") && en.includes(">12<"), "EN 月份标签输出数字");
  } finally {
    setLocale(prev);
  }
});

test("styles.css 审核行可读性回归：mod-cta 对比度与信息列宽", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  // 根因 1：.sd-audit-actions button 只改背景不改颜色，mod-cta 的白字落在浅色背景上（实测 1.1:1）。
  const cta = /\.sd-audit-actions button\.mod-cta\s*\{[^}]*\}/.exec(css);
  assert.ok(cta, "缺少 .sd-audit-actions button.mod-cta 覆盖规则");
  assert.match(cta[0], /color:\s*var\(--text-on-accent\)/, "mod-cta 必须显式声明字色");
  assert.match(cta[0], /background:\s*var\(--interactive-accent\)/, "mod-cta 必须恢复强调背景，不能继承 secondary 浅底");
  // 根因 2：审核行整条信息塞进 112px 元信息列 + faint 10px，路径被截断且对比度 2.85:1。
  const audit = /\.sd-feed-row-audit\s*\{[^}]*\}/.exec(css);
  assert.ok(audit, "缺少审核行独立布局 .sd-feed-row-audit");
  assert.match(audit[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/, "信息列须占剩余宽度，不复用 112px 元信息列");
  const span = /\.sd-feed-row-audit\s*>\s*span\s*\{[^}]*\}/.exec(css);
  assert.ok(span, "缺少审核行信息 span 规则");
  assert.match(span[0], /color:\s*var\(--text-muted\)/, "审核行信息须用可读的 muted 色");
  assert.match(span[0], /font-size:\s*11px/, "审核行信息字号不得低于 11px");
});

test("快照恢复入口迁移：工坊不再渲染、设置备份分区承接", () => {
  const agentSrc = fs.readFileSync("src/views/dashboard/sections/agent.ts", "utf8");
  assert.ok(!agentSrc.includes("renderDataRecovery"), "工坊不应再渲染数据快照恢复卡");
  const settingsSrc = fs.readFileSync("src/ui/settings-tab.ts", "utf8");
  assert.match(settingsSrc, /private renderRecoveryList\(/, "设置备份分区须承接快照恢复列表");
  assert.match(settingsSrc, /restoreDataBackup/, "恢复安全流程须在设置侧保留");
  assert.match(settingsSrc, /sd-feed-row-audit/, "恢复列表须复用可读审核行样式");
});

// ── 阶段一 Task 1：待审写入轻量对账 ──

const pendingRecord = (partial: Partial<PendingWriteRecord> = {}): PendingWriteRecord => ({
  id: "pw-1",
  time: "2026-11-21T00:00:00.000Z",
  tool: "patch_note",
  agent: "agent",
  path: "notes/a.md",
  request: { kind: "patch_note", args: { path: "notes/a.md" } },
  before: "old",
  after: "new",
  ...partial,
});

test("reconcile：before 非空且目标不存在 → stale；新建类不受影响；幂等", () => {
  const records = [
    pendingRecord(),
    pendingRecord({ id: "pw-2", before: "", path: "notes/new.md", tool: "write_note" }),
    pendingRecord({ id: "pw-3", path: "notes/b.md" }),
  ];
  const marked = reconcilePendingWrites(records, (p) => p === "notes/b.md");
  assert.equal(marked, 1);
  assert.equal(records[0].stale, true);
  assert.equal(records[1].stale, undefined, "新建类（before 为空）不标记");
  assert.equal(records[2].stale, undefined);
  assert.equal(reconcilePendingWrites(records, (p) => p === "notes/b.md"), 0, "已标记的不重复计数");
});

test("markStaleByPaths：删除/重命名路径命中即标记", () => {
  const records = [pendingRecord(), pendingRecord({ id: "pw-2", path: "notes/b.md" })];
  assert.equal(markStaleByPaths(records, ["notes/a.md"]), 1);
  assert.equal(records[0].stale, true);
  assert.equal(records[1].stale, undefined);
  assert.equal(markStaleByPaths(records, ["notes/a.md"]), 0, "已 stale 不重复");
});

test("store：reconcilePending / markPendingWritesStale 有标记才落盘", () => {
  const store = Object.create(Store.prototype) as Store;
  let saves = 0;
  (store as any).data = { pendingWrites: [pendingRecord()] };
  (store as any).scheduleSave = () => {
    saves += 1;
  };
  assert.equal(store.reconcilePending(() => false), 1);
  assert.equal(saves, 1);
  assert.equal(store.markPendingWritesStale(["notes/a.md"]), 0, "已 stale 不再计数也不落盘");
  assert.equal(saves, 1);
  (store as any).data.pendingWrites = [pendingRecord({ id: "pw-2" })];
  assert.equal(store.markPendingWritesStale(["notes/a.md"]), 1, "未标记项命中即计入");
  assert.equal(saves, 2, "有标记时落盘");
});

// ── 阶段一 Task 2：采纳守卫 + main.ts 对账接线 ──

test("confirm 档：目标被删除后采纳报 STALE_PENDING，失效项保留待驳回", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "line1\n" });
  const held = (await ctx.api.patchNote({ path: "notes/a.md", find: "line1", content: "X" })) as HoldResult;
  const id = pendingIdOf(held);
  ctx.files.delete("notes/a.md");
  await assert.rejects(ctx.api.approvePendingWrite(id), (error) => asApiError(error).code === "STALE_PENDING");
  assert.equal(ctx.pendingWrites.length, 1, "失效项保留，等用户驳回");
  ctx.api.rejectPendingWrite(id);
  assert.equal(ctx.pendingWrites.length, 0);
});

test("confirm 档：已标记 stale 的待审项直接拒绝采纳", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "line1\n" });
  const held = (await ctx.api.patchNote({ path: "notes/a.md", find: "line1", content: "X" })) as HoldResult;
  const id = pendingIdOf(held);
  ctx.pendingWrites[0].stale = true;
  await assert.rejects(ctx.api.approvePendingWrite(id), (error) => asApiError(error).code === "STALE_PENDING");
  assert.equal(ctx.files.get("notes/a.md"), "line1\n", "未落盘");
});

test("main.ts：删除/重命名标记失效待审项，启动时对账", () => {
  const src = fs.readFileSync("src/main.ts", "utf8");
  assert.ok(src.includes("markPendingWritesStale([file.path])"), "delete 事件须标记被删路径");
  assert.ok(src.includes("markPendingWritesStale([oldPath])"), "rename 事件须标记旧路径");
  assert.ok(src.includes("this.store.reconcilePending("), "启动须做一次对账");
});

// ── 阶段一 Task 3：工坊失效待审 UI ──

test("工坊：stale 待审行渲染失效徽章且只提供驳回", () => {
  const src = fs.readFileSync("src/views/dashboard/sections/agent.ts", "utf8");
  assert.ok(src.includes("item.stale"), "待审行须判断 stale");
  assert.ok(src.includes("sd-audit-badge is-stale"), "stale 徽章类名");
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.sd-audit-badge\.is-stale/);
});

test("i18n：stale 相关英文条目已收录", () => {
  setLocale("en");
  try {
    assert.equal(t("目标已删除/移动"), "Target deleted/moved");
    assert.equal(t("失效项（目标被删除/移动）只能驳回，让 Agent 重发。"), "Stale items (target deleted/moved) can only be rejected; ask the agent to resend.");
  } finally {
    setLocale("zh");
  }
});

// ── 阶段一 Task 4：知识库现状纯函数 ──

test("scanKnowledgeState：只统计知识目录，来源缺失记未登记（不定罪）", () => {
  const files: KnowledgeFile[] = [
    { path: "knowledge/技术/a.md", mtime: Date.UTC(2026, 10, 20), frontmatter: { sediment_status: "draft", source: "agent" } },
    { path: "knowledge/技术/b.md", mtime: Date.UTC(2026, 10, 21), frontmatter: { sediment_status: "accepted", source: "human" } },
    { path: "knowledge/项目/c.md", mtime: Date.UTC(2026, 10, 19), frontmatter: {} },
    { path: "knowledge/root.md", mtime: Date.UTC(2026, 10, 18), frontmatter: { category: "方法" } },
    { path: "notes/outside.md", mtime: Date.now(), frontmatter: {} },
  ];
  const state = scanKnowledgeState(files, "knowledge");
  assert.equal(state.total, 4);
  assert.equal(state.drafts, 1);
  assert.equal(state.accepted, 1);
  assert.equal(state.agentSourced, 1);
  assert.equal(state.humanSourced, 1);
  assert.equal(state.unregistered, 2);
  assert.deepEqual(state.unregisteredPaths.sort(), ["knowledge/root.md", "knowledge/项目/c.md"]);
  assert.deepEqual(state.categories, [
    { name: "技术", count: 2 },
    { name: "方法", count: 1 },
    { name: "项目", count: 1 },
  ]);
  assert.equal(state.lastUpdated, dateKey(new Date(Date.UTC(2026, 10, 21))));
});

test("scanKnowledgeState：空库返回零值；未登记列表封顶 20", () => {
  const empty = scanKnowledgeState([], "knowledge");
  assert.equal(empty.total, 0);
  assert.equal(empty.lastUpdated, null);
  const many: KnowledgeFile[] = Array.from({ length: 25 }, (_, i) => ({
    path: `knowledge/x/f${i}.md`,
    mtime: 0,
    frontmatter: {},
  }));
  const state = scanKnowledgeState(many, "knowledge");
  assert.equal(state.unregistered, 25);
  assert.equal(state.unregisteredPaths.length, 20);
});
