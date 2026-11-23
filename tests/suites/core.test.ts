// core — 从 unit.test.ts 拆出，helpers 来自 ../helpers
import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice, TFile, type Plugin } from "obsidian";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { contentHash } from "../../src/utils/hash";
import { configureAgent, configSnippet, isAgentConfigured, resolveBridgePath } from "../../src/agent/setup";
import * as setupNs from "../../src/agent/setup";
import { BRIDGE_SOURCE } from "../../src/agent/bridge-source";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_SETTINGS,
  type AgentUsageMap,
  type DayRecord,
  type FocusSessionRecord,
  type MemoRecord,
  type PendingWriteRecord,
  type PersistedPomodoro,
  type SedimentSettings,
} from "../../src/types";
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
} from "../../src/utils/dates";
import { countWords, countCheckedTasks, noteDateKey, Tracker } from "../../src/tracker";
import { PomodoroManager, type PomodoroStorage } from "../../src/features/pomodoro";
import { MemoManager } from "../../src/features/memo";
import { buildWeeklyReview } from "../../src/features/review";
import SedimentPlugin from "../../src/main";
import { normalizeFolder } from "../../src/utils/vault";
import { TaskManager } from "../../src/features/tasks";
import { buildStatsCsv, buildExportJson, DEFAULT_EXPORT_OPTIONS, exportData } from "../../src/features/export";
import { todayLine } from "../../src/features/embed";
import { Store } from "../../src/data/store";
import {
  isAgentActive,
  rebuildAgentUsage,
  recentDayCount,
  recentHourCount,
  recordAgentUsage,
  sanitizeAgentUsage,
  summarizeAgentUsage,
  totalAgentCalls,
} from "../../src/data/agent-usage";
import { AgentApi, ApiError, safeAgentPath, stampAgentProvenance } from "../../src/agent/api";
import { FileBridge } from "../../src/features/file-bridge";
import { reconcilePendingWrites, markStaleByPaths } from "../../src/agent/reconcile";
import { SemanticIndex, tokenizeSemanticText } from "../../src/agent/semantic";
import { AgentServer, sanitizeServerError, tokensMatch } from "../../src/agent/server";
import { idempotencyKey, redactAuditPath, redactSecrets } from "../../src/agent/security";
import { computeDiff } from "../../src/ui/diff-modal";
import { barChart, escapeAttr, goalRing, mean, multiLine, referenceLines, ring, sparkline } from "../../src/utils/charts";
import { aggregateStrata, listMonths, recentStrataRange } from "../../src/utils/strata";
import { logError } from "../../src/utils/log-error";
import { getLocale, localeFromPersisted, setLocale, t, tf } from "../../src/i18n";
import { findViolations, stripComments } from "../../scripts/lint-i18n.mjs";
import {
  inferCategory,
  isOperationAllowed,
  isPathAllowedByMode,
  isPathDenied,
  isSafePathSegmentName,
  listCategories,
  splitList,
} from "../../src/agent/access";
import {
  filterAgentTasks,
  pendingChangeRows,
  pendingReviewChanges,
  reviewBadgeCount,
} from "../../src/views/dashboard/review-queue";
import { SETTINGS_SECTIONS, settingsSection } from "../../src/ui/settings-sections";
import {
  OllamaEmbeddingClient,
  cosineSimilarity,
  hashText,
  normalizeEndpoint,
  type RequestFn,
} from "../../src/agent/embedding";
import { renderYearly } from "../../src/views/dashboard/sections/insights";
import { scanKnowledgeState, type KnowledgeFile } from "../../src/features/knowledge-state";
import { delegateHealthIssues, HEALTH_LABEL, scanNoteHealth } from "../../src/features/health";
import {
  LEGACY_FOLDER_MIGRATIONS,
  migrateLegacyFolders,
  planFolderMigrations,
} from "../../src/features/folder-migration";
import {
  bridgePendingId,
  bridgeProposalIdFromPath,
  bridgeTextTooLarge,
  buildBridgeDecision,
  isBridgeProposalId,
  parseBridgeProposal,
} from "../../src/agent/bridge-schema";
import { TFileWithPath, day, settings, accessSettings, fakeStore, LayoutFn, layoutFn, fakeSetupPlugin, openCodeTarget, fakeVault, fakePluginWith, fakeAgentPlugin, TFileStub, asApiError, HoldResult, memoryVault, fakeConfirmPlugin, pendingIdOf, newTFile, noticeMessages, fakeClock, trackerHarness, pomodoroHarness, memoryStorage, memoHarness, rawHttp, seedAgentMemo, pendingRecord, fakeHealthPlugin, fakeSemanticPlugin, fakeEmbed, migrationHarness, fakeBridgeHarness, proposalPath, decisionPath } from "../helpers";
import { readBackup, restoreBackup } from "../../src/features/audit";
import { findSection, applyFrontmatterUpdate } from "../../src/agent/api-helpers";
import { removeTomlServer, removeYamlServer } from "../../src/agent/config-formats";
import { installAgentsGuide, AGENTS_GUIDE } from "../../src/features/agents-guide";
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

test("access：isPathDenied 命中目录及子路径", () => {
  assert.equal(isPathDenied("私有", "私有,归档/secret"), true);
  assert.equal(isPathDenied("私有/日记.md", "私有,归档/secret"), true);
  assert.equal(isPathDenied("公开", "私有,归档/secret"), false);
});

test("access：大小写不敏感（Windows NTFS 与校验口径一致）", () => {
  assert.equal(isPathDenied("private/x.md", "Private"), true);
  assert.equal(isPathDenied("PRIVATE/deep/x.md", "private"), true);
  const allowlist = {
    ...accessSettings,
    agentAccessMode: "allowlist" as const,
    agentAllowedFolders: "Work",
  };
  assert.equal(isPathAllowedByMode("work/x.md", allowlist), true);
  assert.equal(isPathAllowedByMode("WORK/deep/x.md", allowlist), true);
  assert.equal(isPathAllowedByMode("其他/x.md", allowlist), false);
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
  } as unknown as ConstructorParameters<typeof Store>[0];
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

test("config-formats：removeTomlServer/removeYamlServer 精确移除目标段（F2）", () => {
  const toml = `[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.sediment]\ncommand = "node"\nargs = ["a"]\n\n[other]\nx = 1`;
  const tomlOut = removeTomlServer(toml, "sediment");
  assert.doesNotMatch(tomlOut, /mcp_servers\.sediment/);
  assert.match(tomlOut, /mcp_servers\.other/);
  assert.match(tomlOut, /\[other\]/);

  const yaml = `mcp_servers:\n  other:\n    command: x\n  sediment:\n    command: node\n    args:\n      - a\n  last:\n    command: y`;
  const yamlOut = removeYamlServer(yaml, "sediment");
  assert.doesNotMatch(yamlOut, /sediment/);
  assert.match(yamlOut, /other:/);
  assert.match(yamlOut, /last:/);

  // 相似前缀 id 不误删。
  const yaml2 = `mcp_servers:\n  sediment-pro:\n    command: x\n  sediment:\n    command: y`;
  const yamlOut2 = removeYamlServer(yaml2, "sediment");
  assert.match(yamlOut2, /sediment-pro/);
  assert.doesNotMatch(yamlOut2, /^  sediment:$/m);
});

test("exportData：同名文件冲突时递增 -2/-3 不覆盖（F11）", async () => {
  const existing = new Set<string>();
  const created: string[] = [];
  const vault = {
    getAbstractFileByPath: (p: string) => (existing.has(p) ? { path: p } : null),
    createFolder: async () => {},
    create: async (p: string, _c: string) => { created.push(p); existing.add(p); },
  } as never;
  const store = fakeStore();
  const p1 = await exportData(store, vault, { ...DEFAULT_EXPORT_OPTIONS, audit: false });
  existing.add(p1);
  const p2 = await exportData(store, vault, { ...DEFAULT_EXPORT_OPTIONS, audit: false });
  assert.match(p2, /-2\.json$/);
  existing.add(p2);
  const p3 = await exportData(store, vault, { ...DEFAULT_EXPORT_OPTIONS, audit: false });
  assert.match(p3, /-3\.json$/);
});

test("api-helpers：findSection 按标题层级与 index 定位段（F6）", () => {
  const text = "# 标题\n\n## A\naaa\n\n## B\nbbb\n\n# 结尾\nend";
  const a = findSection(text, "## A", 0);
  assert.ok(a);
  assert.equal(a!.lines.slice(a!.start, a!.end).join(" ").trim(), "aaa");
  const b = findSection(text, "## B", 0);
  assert.ok(b);
  assert.match(b!.lines.slice(b!.start, b!.end).join(" "), /bbb/);
  assert.equal(findSection(text, "## A", 1), null, "只有一个 A，index=1 越界");
  assert.ok(findSection(text, "A", 0), "不带 # 的标题名也能匹配");
});

test("api-helpers：applyFrontmatterUpdate 数组/标量/新建（F6）", () => {
  const withFm = "---\ntitle: old\ntags:\n  - a\n---\n正文";
  const updated = applyFrontmatterUpdate(withFm, { title: "new", tags: ["x", "y"] });
  assert.match(updated, /title: "new"/);
  assert.match(updated, /tags:\n  - "x"\n  - "y"/);
  assert.match(updated, /正文/);
  const emptyArr = applyFrontmatterUpdate(withFm, { tags: [] });
  assert.match(emptyArr, /tags: \[\]/);
  const noFm = applyFrontmatterUpdate("正文内容", { status: "draft" });
  assert.match(noFm, /^---\nstatus: "draft"\n---\n/);
  assert.throws(() => applyFrontmatterUpdate("---\ntitle: x\n正文", { a: 1 }), /未闭合/);
});

test("audit：restoreBackup 成功恢复内容；快照缺失不得清空笔记（F1）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-audit-"));
  try {
    const backupDir = path.join(tmp, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "1700000000000-notes_a.md"), "原始内容", "utf8");
    let written = "初始";
    const vault = {
      configDir: ".obsidian",
      adapter: { getFullPath: () => backupDir },
      process: async (_f: { path: string }, cb: (data: string) => string) => { written = cb("当前内容"); },
    } as never;
    const plugin = { app: { vault } } as never;

    const file = new (TFile as unknown as new (path: string) => TFile)("notes/a.md");
    await restoreBackup(plugin, file, "1700000000000-notes_a.md");
    assert.equal(written, "原始内容");

    // 快照不存在（已被清理）→ 抛错，笔记内容不变。
    const before = written;
    await assert.rejects(() => restoreBackup(plugin, file, "nonexistent-snap"));
    assert.equal(written, before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Store.markPendingWritesChanged：外部改动使挂起项失效（F5）", async () => {
  const file = new (TFile as unknown as new (path: string) => TFile)("notes/a.md");
  const currentContent = "外部改过的内容";
  const hashOf = (s: string) => contentHash(s);
  const plugin = {
    loadData: async () => ({ version: 1, settings: DEFAULT_SETTINGS }),
    saveData: async () => {},
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p === "notes/a.md" ? file : null),
        read: async () => currentContent,
      },
    },
  } as unknown as ConstructorParameters<typeof Store>[0];
  const store = new Store(plugin);
  await store.load();
  store.data.pendingWrites = [
    { id: "p1", time: "t", tool: "write_note", agent: "a", path: "notes/a.md", request: { kind: "write_note", args: {} }, before: "旧内容", beforeHash: hashOf("旧内容"), after: "" },
    { id: "p2", time: "t", tool: "write_note", agent: "a", path: "other.md", request: { kind: "write_note", args: {} }, before: "旧", after: "" },
  ];
  const savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {} };
  let marked = 0;
  try {
    marked = await store.markPendingWritesChanged(["notes/a.md"]);
  } finally {
    (globalThis as { window?: unknown }).window = savedWindow;
  }
  assert.equal(marked, 1);
  assert.equal(store.data.pendingWrites[0].stale, true, "内容被外部改动 → stale");
  assert.equal(store.data.pendingWrites[1].stale, undefined, "非目标路径不受影响");
});

test("agents-guide：一键安装 AGENTS.md，存在则不覆盖（C4）", () => {
  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath: (p: string) => (files.has(p) ? { path: p } : null),
    create: async (p: string, content: string) => { files.set(p, content); },
  } as never;
  assert.equal(installAgentsGuide(vault), true);
  assert.equal(files.get("AGENTS.md"), AGENTS_GUIDE);
  // 已存在时不覆盖。
  files.set("AGENTS.md", "自定义规则");
  assert.equal(installAgentsGuide(vault), false);
  assert.equal(files.get("AGENTS.md"), "自定义规则");
});

test("audit：非法快照名拒绝路径穿越（A4）", async () => {
  const vault = {
    configDir: ".obsidian",
    adapter: { getFullPath: (p: string) => `ROOT/${p}` },
    process: async (_f: unknown, cb: (data: string) => string) => cb("不应被调用"),
  };
  const plugin = { app: { vault } } as never;
  // readBackup 对非法名直接返回空串，不触盘。
  assert.equal(readBackup(plugin, "../../etc/passwd"), "");
  assert.equal(readBackup(plugin, "a/b.md"), "");
  // restoreBackup 对非法名抛错，且不会调用 vault.process。
  let processed = false;
  (vault as { process: unknown }).process = async () => { processed = true; };
  await assert.rejects(() => restoreBackup(plugin, new (TFile as unknown as new (path: string) => TFile)("x.md"), "../evil"));
  assert.equal(processed, false);
});

test("Store.load：数组中畸形元素被过滤，不污染下游（A6）", async () => {
  const plugin = {
    loadData: async () => ({
      version: 1,
      memos: [{ id: "m1", date: "2026-11-20", time: "10:00", text: "正常", tags: [], converted: false }, {}, null],
      snapshots: [{ id: "s1", path: "a.md", time: "t" }, { id: "bad" }],
      toolCalls: [{ time: "t", tool: "GET /x", agent: "a", path: "a.md" }, {}],
      workLogs: [{ id: "w1", date: "2026-11-20", time: "10:00", agent: "a", task: "t" }, 42],
      diagnostics: [{ time: "t", category: "security", message: "m" }, {}],
    }),
    saveData: async () => {},
  } as unknown as ConstructorParameters<typeof Store>[0];
  const store = new Store(plugin);
  await store.load();

  assert.equal(store.data.memos.length, 1);
  assert.equal(store.data.memos[0].text, "正常");
  assert.equal(store.data.snapshots.length, 1);
  assert.equal(store.data.toolCalls.length, 1);
  assert.equal(store.data.workLogs.length, 1);
  assert.equal(store.data.diagnostics.length, 1);
});

test("Store.logDiagnostic：令牌不落明文诊断与工具路径（A5）", () => {
  const token = "supersecret-token-123";
  const plugin = {
    loadData: async () => ({ version: 1, settings: { ...DEFAULT_SETTINGS, diagnosticsEnabled: true, agentServerToken: token } }),
    saveData: async () => {},
  } as unknown as ConstructorParameters<typeof Store>[0];
  const store = new Store(plugin);
  // 直接设置内存数据（跳过 load 的异步）以聚焦脱敏逻辑。
  store.data = { ...store.data, settings: { ...DEFAULT_SETTINGS, diagnosticsEnabled: true, agentServerToken: token } };

  store.logDiagnostic("security", `尝试令牌 ${token} 访问`, `detail ${token}`, false);
  assert.ok(!JSON.stringify(store.data.diagnostics).includes(token));
  assert.match(store.data.diagnostics[0].message, /\[REDACTED\]/);

  // logToolCall 会触发 scheduleSave（依赖 window），本测试只关心路径脱敏，临时提供桩。
  const savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  try {
    store.logToolCall({ time: new Date().toISOString(), tool: "GET /x", agent: "a", path: `notes/${token}.md` }, false);
  } finally {
    (globalThis as { window?: unknown }).window = savedWindow;
  }
  assert.ok(!JSON.stringify(store.data.toolCalls).includes(token));
});

test("Store.load：未知版本暂停写入并保留警告", async () => {
  let saveCalls = 0;
  const fakePlugin = {
    loadData: async () => ({ version: 99, days: { "2026-11-20": day({ wordsAdded: 100 }) } }),
    saveData: async () => { saveCalls += 1; },
  } as unknown as ConstructorParameters<typeof Store>[0];
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
    } as unknown as ConstructorParameters<typeof Store>[0];
    const store = new Store(fakePlugin);

    await store.load();
    await store.save();

    assert.ok(store.migrationWarning);
    assert.equal(saveCalls, 0);
  }
});

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
  } as unknown as ConstructorParameters<typeof Store>[0];
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
  assert.match(written[0][0], /^data-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-[a-z0-9]+\.json$/);
  assert.equal(trashed.length, 0);
});

test("Store.backupData：正常目录按保留份数清理，不误删目录外文件", async () => {
  const { vault, trashed } = fakeVault([
    { path: "Sediment/backups/data-2026-11-18-0800.json", mtime: 1 },
    { path: "Sediment/backups/data-2026-11-19-0800.json", mtime: 2 },
    { path: "Sediment/backups/data-2026-11-20-0800.json", mtime: 3 },
    { path: "data-root.json", mtime: 0 },
    { path: "Sediment/backups/sub/data-nested.json", mtime: 0 },
  ]);
  const { plugin } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();
  store.data.settings.backupKeep = 2;

  const count = await store.backupData(true);

  assert.equal(count, 1);
  // 新备份不在 getFiles 列表里，列表中最旧的一份被清理。
  assert.deepEqual(trashed, ["Sediment/backups/data-2026-11-18-0800.json"]);
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
  } as unknown as ConstructorParameters<typeof Store>[0];
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

test("Store.save：写失败退避重试，并发保存串行化不重叠", async () => {
  const { vault } = fakeVault();
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const plugin = {
    loadData: async () => ({ version: 1 }),
    saveData: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (calls <= 2) throw new Error("transient");
    },
    app: { vault },
  } as unknown as ConstructorParameters<typeof Store>[0];
  const store = new Store(plugin);
  await store.load();
  await Promise.all([store.save(), store.save()]);
  assert.equal(maxInFlight, 1, "两次保存必须串行");
  assert.equal(calls, 4, "第一次写失败重试两次后成功，第二次一次成功");
});

test("Store.listDataBackups：只列备份目录内 data 快照，按时间倒序", async () => {
  const { vault } = fakeVault([
    { path: "Sediment/backups/data-2026-11-19-0800.json", mtime: 200, size: 20 },
    { path: "Sediment/backups/data-2026-11-20-0800.json", mtime: 300, size: 30 },
    { path: "Sediment/backups/notes.json", mtime: 400, size: 5 },
    { path: "Sediment/backups/sub/data-nested.json", mtime: 500, size: 5 },
    { path: "data-root.json", mtime: 600, size: 5 },
    { path: "Sediment/backups/data-2026-11-18-0800.md", mtime: 700, size: 5 },
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
    { path: `Sediment/backups/${backupName}`, mtime: 200, size: backupContent.length },
  ]);
  written.push([`Sediment/backups/${backupName}`, backupContent]);
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
    { path: `Sediment/backups/${backupName}`, mtime: 200, size: 10 },
  ]);
  const { plugin, saved } = fakePluginWith(vault, null);
  const store = new Store(plugin);
  await store.load();

  written.push([`Sediment/backups/${backupName}`, JSON.stringify({ version: 1, days: [] })]);
  await assert.rejects(() => store.restoreDataBackup(backupName), /备份内容损坏/);
  written.length = 0;
  written.push([`Sediment/backups/${backupName}`, "{not json"]);
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
    assert.throws(() => safeAgentPath(value, ".obsidian"), ApiError);
  }
  // 自定义配置目录同样拦截，不再依赖固定的 .obsidian 名称。
  assert.throws(() => safeAgentPath("config/data.json", "config"), ApiError);
});

test("Agent 安全路径：规范化反斜杠并保留合法路径", () => {
  assert.equal(safeAgentPath("notes\\daily\\2026.md", ".obsidian"), "notes/daily/2026.md");
  assert.equal(safeAgentPath("/notes//memo.md", ".obsidian"), "notes/memo.md");
  assert.equal(safeAgentPath("notes/config.md", "config"), "notes/config.md");
});

test("Store：工作日志保留上限，避免无界增长", () => {
  const store = new Store({} as unknown as ConstructorParameters<typeof Store>[0]);
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
  const store = new Store({} as unknown as ConstructorParameters<typeof Store>[0]);
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
  const store = new Store({ loadData: async () => ({ version: 1, days }) } as unknown as ConstructorParameters<typeof Store>[0]);
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

test("新客户端：agentCandidates 包含 Claude Code / Codex / Hermes / VS Code 四种格式", () => {
  const all = setupNs.allAgentCandidates("C:/Users/test", "C:/Users/test/AppData/Roaming");
  const ids = all.map((a) => a.id);
  for (const id of ["claude-code", "codex", "hermes", "vscode"]) {
    assert.ok(ids.includes(id), `应包含 ${id}`);
  }
  const codex = all.find((a) => a.id === "codex")!;
  assert.equal(codex.format, "toml");
  assert.ok(codex.configPath.endsWith("config.toml"));
  const hermes = all.find((a) => a.id === "hermes")!;
  assert.equal(hermes.format, "yaml");
  assert.ok(hermes.configPath.endsWith("config.yaml"));
  // Windows：Hermes 用 %LOCALAPPDATA%\hermes\，不是 Roaming 也不是 ~/.hermes
  const win = setupNs.allAgentCandidates("C:/Users/u", "C:/Users/u/AppData/Roaming", "C:/Users/u/AppData/Local");
  assert.ok(win.find((a) => a.id === "hermes")!.configPath.includes("AppData/Local"));
});

test("新客户端：Claude Code 使用 mcpServers（JSON），配置写入 mcpServers.sediment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-claudecode-"));
  try {
    const cfgPath = path.join(tmp, ".claude.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const target = setupNs.allAgentCandidates(tmp, tmp).find((a) => a.id === "claude-code")!;
    target.configPath = cfgPath;
    assert.equal(isAgentConfigured(target), false);
    configureAgent(fakeSetupPlugin(tmp), target);
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.ok(data.mcpServers.sediment, "应写入 mcpServers.sediment");
    assert.equal(isAgentConfigured(target), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("新客户端：Codex 写入 TOML [mcp_servers.sediment]，可重复覆盖", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-codex-"));
  try {
    const cfgPath = path.join(tmp, "config.toml");
    fs.writeFileSync(cfgPath, "model = \"gpt-6\"\n\n[mcp_servers.other]\ncommand = \"x\"\n", "utf8");
    const target = setupNs.allAgentCandidates(tmp, tmp).find((a) => a.id === "codex")!;
    target.configPath = cfgPath;
    configureAgent(fakeSetupPlugin(tmp), target);
    let raw = fs.readFileSync(cfgPath, "utf8");
    assert.match(raw, /\[mcp_servers\.sediment\]/);
    assert.match(raw, /command = "node"/);
    assert.match(raw, /SEDIMENT_TOKEN = "/);
    assert.match(raw, /\[mcp_servers\.other\]/, "其它段应保留");
    assert.equal(isAgentConfigured(target), true);
    // 重复写入不应产生两个 sediment 段
    configureAgent(fakeSetupPlugin(tmp), target);
    raw = fs.readFileSync(cfgPath, "utf8");
    assert.equal((raw.match(/\[mcp_servers\.sediment\]/g) || []).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("新客户端：Hermes 写入 YAML mcp_servers.sediment，可重复覆盖并保留其它键", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sediment-hermes-"));
  try {
    const cfgPath = path.join(tmp, "config.yaml");
    fs.writeFileSync(cfgPath, "model: gpt-6\nmcp_servers:\n  other:\n    command: x\n", "utf8");
    const target = setupNs.allAgentCandidates(tmp, tmp).find((a) => a.id === "hermes")!;
    target.configPath = cfgPath;
    configureAgent(fakeSetupPlugin(tmp), target);
    let raw = fs.readFileSync(cfgPath, "utf8");
    assert.match(raw, /mcp_servers:/);
    assert.match(raw, /  sediment:/);
    assert.match(raw, /    command: "node"/);
    assert.match(raw, /^model: gpt-6$/m, "其它顶层键应保留");
    assert.match(raw, /  other:/, "其它 MCP 段应保留");
    assert.equal(isAgentConfigured(target), true);
    configureAgent(fakeSetupPlugin(tmp), target);
    raw = fs.readFileSync(cfgPath, "utf8");
    assert.equal((raw.match(/^  sediment:/gm) || []).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("新客户端：VS Code 使用 servers（JSON），configSnippet 输出对应结构", () => {
  const vscodeSnippet = JSON.parse(configSnippet(fakeSetupPlugin(""), "vscode"));
  assert.ok(vscodeSnippet.servers.sediment, "VS Code 片段应使用 servers 键");
  const codexSnippet = configSnippet(fakeSetupPlugin(""), "codex");
  assert.match(codexSnippet, /\[mcp_servers\.sediment\]/);
  const hermesSnippet = configSnippet(fakeSetupPlugin(""), "hermes");
  assert.match(hermesSnippet, /mcp_servers:/);
});