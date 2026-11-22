// misc — 从 unit.test.ts 拆出，helpers 来自 ../helpers
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
  type PulseSettings,
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
import { buildStatsCsv, buildExportJson, DEFAULT_EXPORT_OPTIONS } from "../../src/features/export";
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

test("终审 1：claimAgentTask/completeAgentTask 日记路径过 patch 门禁；人用 bypass 面不受影响", async () => {
  // 黑名单含日记目录：Agent claim/complete 都 403，零落盘（标签不动、syncTags 不触达）。
  const denied = fakeConfirmPlugin({ agentWorkMode: "auto", deniedFolders: DEFAULT_SETTINGS.dailyNoteFolder });
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
    agentWorkMode: "readonly", deniedFolders: DEFAULT_SETTINGS.dailyNoteFolder,
    agentAllowRead: true, agentAllowCreate: false, agentAllowPatch: false, agentAllowOverwrite: false,
  });
  let humanSync = 0;
  human.plugin.memos.syncTags = async () => { humanSync += 1; };
  seedAgentMemo(human);
  const claimed = (await human.api.claimAgentTask("m1", true)) as MemoRecord;
  assert.deepEqual(claimed.tags, ["agent-in-progress"]);
  const done = (await human.api.completeAgentTask("m1", "知识/产出.md", true)) as MemoRecord;
  assert.deepEqual((done as MemoRecord).tags, ["agent-done"]);
  assert.equal(done.converted, true);
  assert.equal(done.resultPath, "知识/产出.md");
  assert.equal(humanSync, 2, "人用面两次操作都正常同步日记标签");
});

test("终审 2：recordWorkLog 目标已存在按 patch 过门禁——draft 档第二次被拒且不改动既有日志", async () => {
  const draftFlags = { agentAllowRead: true, agentAllowCreate: true, agentAllowPatch: false, agentAllowOverwrite: false };
  const ctx = fakeConfirmPlugin({ agentWorkMode: "draft", ...draftFlags });
  const first = (await ctx.api.recordWorkLog({ task: "t1", summary: "第一条" })) as HoldResult;
  assert.equal(first.pending, undefined, "draft 档首条直接新建落盘");
  const logPath = `Sediment/agent-logs/${dateKey(new Date())}.md`;
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
  const files = { "Sediment/daily/2020-01-01.md": "- [ ] 遗留任务\n" };
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
  class FakeSvg {
    readonly tagName = "svg";
    constructor(readonly raw: string) {}
  }
  const globals = globalThis as unknown as { DOMParser: unknown };
  const previousParser = globals.DOMParser;
  globals.DOMParser = class {
    parseFromString(svg: string) {
      return { body: { firstElementChild: new FakeSvg(svg) } };
    }
  };
  const slot = {
    ownerDocument: { importNode: (node: unknown) => node },
    appendChild: (node: FakeSvg) => { html.push(node.raw); },
    replaceChildren: () => {},
    setAttribute: () => {},
    querySelector: () => undefined,
    createDiv: () => ({}),
  };
  const card = { setAttribute: () => {}, querySelector: () => undefined, createDiv: () => slot };
  const view = {
    yearlyTab: "wheel",
    analyticsCard: () => card,
    render: () => {},
    plugin: { store: { settings: { showMoonPhase: true }, data: { days }, getDay: (key: string) => days[key] ?? createEmptyDay() } },
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
    globals.DOMParser = previousParser;
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

test("上架准备：manifest 描述为英文且桌面专用，README 有英文概述，本地提交清单格式正确", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8")) as {
    description: string;
    isDesktopOnly: boolean;
  };
  assert.equal(/[\u4e00-\u9fff]/.test(manifest.description), false);
  assert.match(manifest.description, /Local-first/i);
  assert.equal(manifest.isDesktopOnly, true, "使用 Node API 须标记桌面专用");
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /local, controllable AI write auditing/i);
  // 社区目录以英文为主：主 README 不得混入中文字面量，中文完整文档在 README.zh-CN.md。
  assert.equal(/[\u4e00-\u9fff]/.test(readme), false, "README.md 应保持纯英文");
  const readmeZh = fs.readFileSync("README.zh-CN.md", "utf8");
  assert.match(readmeZh, /README\.md/);
  // 提交清单本地维护、不入库（docs/ 已忽略）：CI 无此文件时跳过，不能因此判失败。
  const checklistPath = "docs/marketplace-submission.md";
  if (fs.existsSync(checklistPath)) {
    const checklist = fs.readFileSync(checklistPath, "utf8");
    assert.match(checklist, /community\.obsidian\.md/);
    assert.match(checklist, /不带 `v` 前缀/);
    assert.match(checklist, /main\.js/);
  }
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

test("i18n：stale 相关英文条目已收录", () => {
  setLocale("en");
  try {
    assert.equal(t("目标已删除/移动"), "Target deleted/moved");
    assert.equal(t("失效项（目标被删除/移动）只能驳回，让 Agent 重发。"), "Stale items (target deleted/moved) can only be rejected; ask the agent to resend.");
  } finally {
    setLocale("zh");
  }
});

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

test("i18n：知识库现状卡英文条目已收录", () => {
  setLocale("en");
  try {
    assert.equal(t("知识库现状"), "Knowledge base");
    assert.equal(t("来源未登记"), "Unregistered source");
  } finally {
    setLocale("zh");
  }
});

test("i18n：来源未登记卡英文条目已收录", () => {
  setLocale("en");
  try {
    assert.equal(t("标记为人工"), "Mark as human");
    assert.equal(t("已标记为人工来源"), "Marked as human source");
  } finally {
    setLocale("zh");
  }
});

test("健康度六项：草稿滞留 / 疑似重复 / 空壳；排序与上限不变", () => {
  const old = Date.now() - 30 * 86400000;
  const plugin = fakeHealthPlugin(
    [
      { path: "knowledge/技术/草稿.md", mtime: old, frontmatter: { sediment_status: "draft" } },
      { path: "a/同名.md", size: 100 },
      { path: "b/同名.md", size: 100 },
      { path: "c/空.md", size: 4 },
    ],
    {},
    { knowledgeFolder: "knowledge" }
  );
  const issues = scanNoteHealth(plugin);
  const kinds = issues.map((issue) => issue.kind);
  assert.ok(kinds.includes("draft-stale"));
  assert.ok(kinds.includes("duplicate-title"));
  assert.ok(kinds.includes("empty-note"));
  const order = { "broken-link": 0, "draft-stale": 1, "duplicate-title": 2, orphan: 3, "empty-note": 4, stale: 5 } as Record<string, number>;
  const sorted = [...issues].sort((a, b) => order[a.kind] - order[b.kind]);
  assert.deepEqual(issues.map((issue) => issue.kind), sorted.map((issue) => issue.kind));
  const draft = issues.find((issue) => issue.kind === "draft-stale");
  assert.match(draft?.detail ?? "", /30 天/);
  assert.equal(issues.filter((issue) => issue.kind === "duplicate-title").length, 2);
});

test("健康度：知识目录外的 draft 不触发草稿滞留", () => {
  const old = Date.now() - 30 * 86400000;
  const plugin = fakeHealthPlugin(
    [{ path: "notes/draft.md", mtime: old, frontmatter: { sediment_status: "draft" } }],
    {},
    { knowledgeFolder: "knowledge" }
  );
  const issues = scanNoteHealth(plugin);
  assert.equal(issues.some((issue) => issue.kind === "draft-stale"), false);
});

test("EN locale：addKnowledge 生成的知识笔记零 CJK", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto", knowledgeFolder: "knowledge" });
  setLocale("en");
  try {
    const result = await ctx.api.addKnowledge({
      title: "Local search",
      content: "TF-IDF baseline with optional embeddings.",
      tags: ["search"],
      category: "tech",
    });
    const doc = ctx.files.get(result.path) ?? "";
    assert.equal(/[\u4e00-\u9fff]/.test(doc), false, doc);
    assert.match(doc, /Summary/);
  } finally {
    setLocale("zh");
  }
});

test("EN locale：recordWorkLog 生成的工作日志零 CJK", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto" });
  setLocale("en");
  try {
    await ctx.api.recordWorkLog({
      agent: "qoder",
      task: "Ship stale guard",
      summary: "Added STALE_PENDING rejection.",
    });
    // R4：workLogFolder 默认 Sediment/agent-logs，路径不是库根。
    const doc = ctx.files.get(`Sediment/agent-logs/${dateKey(new Date())}.md`) ?? "";
    assert.equal(/[\u4e00-\u9fff]/.test(doc), false, doc);
  } finally {
    setLocale("zh");
  }
});

test("EN locale：健康任务文本零 CJK", async () => {
  const ctx = fakeConfirmPlugin({});
  setLocale("en");
  try {
    await delegateHealthIssues(ctx.plugin as never, [
      { kind: "orphan", path: "notes/a.md", detail: "no links" },
    ]);
    const memo = ctx.plugin.store.data.memos[0];
    assert.ok(memo, "须创建任务速记");
    assert.equal(/[\u4e00-\u9fff]/.test(memo.text), false, memo.text);
    assert.ok(memo.text.includes(t(HEALTH_LABEL.orphan)), memo.text);
  } finally {
    setLocale("zh");
  }
});

test("EN locale：searchNotes 的速记/工作日志/草稿标题零 CJK", async () => {
  // 草稿分支靠 basename 命中 + frontmatter.sediment_status，正文不含 needle，
  // 因此三条结果分别来自 memo / worklog / draft 三个分支。
  const ctx = fakeConfirmPlugin({}, { "knowledge/english-draft.md": "Awaiting review.\n" });
  ctx.plugin.app.metadataCache.getFileCache = (file: { path: string }) =>
    file.path === "knowledge/english-draft.md" ? { frontmatter: { sediment_status: "draft" } } : undefined;
  ctx.plugin.store.data.memos.push({
    id: "m1", date: "2026-11-21", time: "10:00", text: "english note", tags: [], converted: false,
  });
  ctx.plugin.store.data.workLogs.push({
    id: "w1", date: "2026-11-21", time: "11:00", agent: "qoder",
    task: "english task", summary: "english summary", decisions: "", files: [],
    learnings: "", openQuestions: "", tags: [],
  });
  setLocale("en");
  try {
    const hits = await ctx.api.searchNotes("english");
    assert.equal(hits.length, 3, JSON.stringify(hits));
    for (const hit of hits) {
      assert.equal(/[\u4e00-\u9fff]/.test(hit.title), false, hit.title);
    }
    assert.equal(hits.find((hit) => hit.kind === "memo")?.title, "Memo 2026-11-21 10:00");
    assert.equal(hits.find((hit) => hit.kind === "worklog")?.title, "Work log 2026-11-21 11:00 · qoder");
    const draft = hits.find((hit) => hit.kind === "draft");
    assert.ok(draft, "须命中草稿标题");
    assert.equal(draft.title, "english-draft");
    assert.equal(draft.snippet, "Knowledge draft pending review");
  } finally {
    setLocale("zh");
  }
  const zhHits = await ctx.api.searchNotes("english");
  assert.equal(zhHits.find((hit) => hit.kind === "memo")?.title, "速记 2026-11-21 10:00");
});

test("embedding：Ollama 客户端形状校验与错误路径", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const client = new OllamaEmbeddingClient("http://127.0.0.1:11434/", "bge-m3", async (options) => {
    calls.push({ url: options.url, body: options.body ?? "" });
    const body = JSON.parse(options.body ?? "{}") as { input: string[] };
    return { status: 200, json: { embeddings: body.input.map(() => [0.1, 0.2, 0.3]) } };
  });
  const vectors = await client.embed(["a", "b"]);
  assert.equal(vectors.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/embed", "端点去尾斜杠");
  const failing = new OllamaEmbeddingClient("http://127.0.0.1:11434", "bge-m3", async () => ({ status: 500, json: {} }));
  await assert.rejects(failing.embed(["x"]), /HTTP 500/);
  const malformed = new OllamaEmbeddingClient("http://127.0.0.1:11434", "bge-m3", async () => ({
    status: 200,
    json: { embeddings: [["bad"]] },
  }));
  await assert.rejects(malformed.embed(["x"]), /格式非法/);
});

test("embedding：余弦相似度与文本哈希稳定", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0, "维度不一致不得因截断而满分");
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("embedding：客户端拒绝非回环端点，回环地址照常构造", () => {
  const fakeEmbed: RequestFn = async () => ({ status: 200, json: { embeddings: [] } });
  assert.throws(
    () => new OllamaEmbeddingClient("http://example.com:11434", "bge-m3", fakeEmbed),
    /回环/
  );
  assert.ok(new OllamaEmbeddingClient("http://localhost:11434", "bge-m3", fakeEmbed));
  assert.ok(new OllamaEmbeddingClient("http://127.0.0.1:11434", "bge-m3", fakeEmbed));
});

test("SemanticIndex embedding：按余弦排序并标记 matchSource", async () => {
  const ctx = fakeSemanticPlugin(
    { "a.md": "apple pie", "b.md": "banana bread" },
    { semanticEngine: "embedding" }
  );
  const index = new SemanticIndex(ctx.plugin, fakeEmbed);
  const hits = await index.search("apple");
  assert.equal(hits[0].path, "a.md");
  assert.equal(hits[0].matchSource, "embedding");
});

test("SemanticIndex embedding：客户端失败自动回退 TF-IDF 并记诊断", async () => {
  const ctx = fakeSemanticPlugin({ "a.md": "apple pie" }, { semanticEngine: "embedding" });
  const failing: RequestFn = async () => {
    throw new Error("connection refused");
  };
  const index = new SemanticIndex(ctx.plugin, failing);
  const hits = await index.search("apple");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchSource, "tf-idf");
  assert.ok(ctx.diagnostics.some((item) => /回退 TF-IDF/.test(item.message)));
});

test("SemanticIndex embedding：增量缓存只 embed 变化文件", async () => {
  const inputs: string[][] = [];
  const counting: RequestFn = async (options) => {
    const body = JSON.parse(options.body ?? "{}") as { input: string[] };
    inputs.push(body.input);
    return fakeEmbed(options);
  };
  const ctx = fakeSemanticPlugin({ "a.md": "apple", "b.md": "banana" }, { semanticEngine: "embedding" });
  const index = new SemanticIndex(ctx.plugin, counting);
  await index.search("apple");
  assert.equal(inputs.length, 2, "文档批 + 查询向量各一次请求");
  assert.deepEqual(
    [...inputs[0]].sort(),
    ["apple", "banana"],
    "两篇同批一次请求（顺序随 vault）"
  );
  ctx.fileStore.set("b.md", "banana bread updated");
  index.invalidate();
  await index.search("apple");
  assert.equal(inputs.length, 4, "第二次仅新增文档批 + 查询向量");
  assert.deepEqual(inputs[2], ["banana bread updated"], "只 embed 变化的 b.md");
});

test("SemanticIndex：默认 TF-IDF 不发 embedding 请求；embedding 结果同样过门禁", async () => {
  let calls = 0;
  const counting: RequestFn = async (options) => {
    calls += 1;
    return fakeEmbed(options);
  };
  const tfidf = new SemanticIndex(fakeSemanticPlugin({ "a.md": "apple" }).plugin, counting);
  const hits = await tfidf.search("apple");
  assert.equal(hits[0].matchSource, "tf-idf");
  assert.equal(calls, 0);

  const ctx = fakeSemanticPlugin(
    { "a.md": "apple", "private/x.md": "apple secret" },
    { semanticEngine: "embedding" }
  );
  const denied = new SemanticIndex(ctx.plugin, counting);
  // 先放开门禁建索引：private/x.md 的向量确实进了内存，后续只能靠逐条门禁拦住。
  const open = await denied.search("apple");
  assert.equal(open.some((hit) => hit.path === "private/x.md"), true, "建索引时未设黑名单");

  (ctx.plugin as any).store.settings.deniedFolders = "private";
  const results = await denied.search("apple");
  assert.equal(results.some((hit) => hit.path === "private/x.md"), false);

  // 显式失效重建后再查，同样不能命中。
  denied.invalidate();
  const rebuilt = await denied.search("apple");
  assert.equal(rebuilt.some((hit) => hit.path === "private/x.md"), false);
});

test("默认目录：日记 / 复盘 / 工作日志 / 知识 / 备份全部位于 Sediment/ 下", () => {
  assert.deepEqual(
    {
      dailyNoteFolder: DEFAULT_SETTINGS.dailyNoteFolder,
      reviewFolder: DEFAULT_SETTINGS.reviewFolder,
      workLogFolder: DEFAULT_SETTINGS.workLogFolder,
      knowledgeFolder: DEFAULT_SETTINGS.knowledgeFolder,
      backupFolder: DEFAULT_SETTINGS.backupFolder,
    },
    {
      dailyNoteFolder: "Sediment/daily",
      reviewFolder: "Sediment/reviews",
      workLogFolder: "Sediment/agent-logs",
      knowledgeFolder: "Sediment/knowledge",
      backupFolder: "Sediment/backups",
    }
  );
  // 迁移表的新旧值必须与默认值一一对应，避免只改一侧。
  for (const item of LEGACY_FOLDER_MIGRATIONS) {
    assert.equal(DEFAULT_SETTINGS[item.key], item.to);
  }
});

test("planFolderMigrations：只迁移仍是旧默认值的目录，自定义路径不动", () => {
  assert.deepEqual(
    planFolderMigrations(
      settings({
        dailyNoteFolder: "daily",
        reviewFolder: "reviews",
        workLogFolder: "agent-logs",
        knowledgeFolder: "knowledge",
        backupFolder: "sediment-backup",
      })
    ).map((item) => item.key),
    ["dailyNoteFolder", "reviewFolder", "workLogFolder", "knowledgeFolder", "backupFolder"]
  );
  assert.deepEqual(planFolderMigrations(settings()), [], "新默认值下无需迁移");
  assert.deepEqual(
    planFolderMigrations(settings({ dailyNoteFolder: "my/daily", knowledgeFolder: "knowledge" })).map((item) => item.key),
    ["knowledgeFolder"]
  );
  // 首尾斜杠、重复斜杠按归一化后的路径判断。
  assert.deepEqual(
    planFolderMigrations(settings({ reviewFolder: "/reviews/" })).map((item) => item.key),
    ["reviewFolder"]
  );
});

test("migrateLegacyFolders：逐文件移入 Sediment/、更新设置并清理空目录", async () => {
  const h = migrationHarness([
    "daily/2026-11-21.md",
    "daily/2026-11-20.md",
    "knowledge/技术/a.md",
    "notes/keep.md",
  ]);
  const s = settings({ dailyNoteFolder: "daily", knowledgeFolder: "knowledge" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.deepEqual(outcome.migrated.map((item) => item.key), ["dailyNoteFolder", "knowledgeFolder"]);
  assert.equal(outcome.movedFiles, 3);
  assert.equal(s.dailyNoteFolder, "Sediment/daily");
  assert.equal(s.knowledgeFolder, "Sediment/knowledge");
  // 按路径排序逐个移动，文件夹层级（技术/）保留。
  assert.deepEqual(h.renamed, [
    ["daily/2026-11-20.md", "Sediment/daily/2026-11-20.md"],
    ["daily/2026-11-21.md", "Sediment/daily/2026-11-21.md"],
    ["knowledge/技术/a.md", "Sediment/knowledge/技术/a.md"],
  ]);
  assert.equal(h.paths.has("daily/2026-11-20.md"), false);
  assert.equal(h.paths.has("Sediment/knowledge/技术/a.md"), true);
  assert.equal(h.paths.has("notes/keep.md"), true, "目录外文件不受影响");
  assert.deepEqual(h.removed, ["daily", "knowledge/技术", "knowledge"]);
  // 真实 Obsidian 的 rename 不建目录：必须先补建 Sediment/ 及各层目标目录。
  assert.equal(h.folders.has("Sediment"), true);
  assert.equal(h.folders.has("Sediment/daily"), true);
  assert.equal(h.folders.has("Sediment/knowledge/技术"), true, "子目录层级同样补建");
});

test("migrateLegacyFolders：旧目录不存在时只更新设置", async () => {
  const h = migrationHarness([]);
  const s = settings({ reviewFolder: "reviews" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.deepEqual(outcome.migrated.map((item) => item.key), ["reviewFolder"]);
  assert.equal(outcome.movedFiles, 0);
  assert.equal(s.reviewFolder, "Sediment/reviews");
});

test("migrateLegacyFolders：目标已有同名文件时整目录跳过，不移动任何文件", async () => {
  const h = migrationHarness(["daily/a.md", "daily/b.md", "Sediment/daily/a.md"]);
  const s = settings({ dailyNoteFolder: "daily" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.equal(outcome.migrated.length, 0);
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /同名文件/);
  assert.equal(s.dailyNoteFolder, "daily", "冲突时设置保持旧值");
  assert.deepEqual(h.renamed, []);
});

test("migrateLegacyFolders：目标路径被同名文件占用时跳过", async () => {
  const h = migrationHarness(["daily/a.md", "Sediment/daily"]);
  const s = settings({ dailyNoteFolder: "daily" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /被同名文件占用/);
  assert.equal(s.dailyNoteFolder, "daily");
});

test("migrateLegacyFolders：子目录目标被文件占用时跳过，不移动也不建目录", async () => {
  const h = migrationHarness(["daily/sub/a.md", "Sediment/daily/sub"]);
  const s = settings({ dailyNoteFolder: "daily" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /Sediment\/daily\/sub/);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(s.dailyNoteFolder, "daily");
  assert.deepEqual(h.renamed, []);
  assert.equal(h.paths.has("daily/sub/a.md"), true, "源文件原地保留");
});

test("migrateLegacyFolders：移动中途失败时回滚已移动文件，设置不变", async () => {
  const h = migrationHarness(["daily/a.md", "daily/b.md"], "Sediment/daily/b.md");
  const s = settings({ dailyNoteFolder: "daily" });

  const outcome = await migrateLegacyFolders({ settings: s, vault: h.vault, fileManager: h.fileManager });

  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].reason, /disk full/);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(s.dailyNoteFolder, "daily");
  assert.deepEqual(h.renamed, [
    ["daily/a.md", "Sediment/daily/a.md"],
    ["Sediment/daily/a.md", "daily/a.md"],
  ]);
  assert.equal(h.paths.has("daily/a.md"), true);
  assert.equal(h.paths.has("daily/b.md"), true);
});

test("文件桥 schema：三类提案规范化与默认值", () => {
  const write = parseBridgeProposal("demo-1", {
    version: 1,
    agent: "opencode",
    tool: "write_note",
    args: { path: "notes/a.md", content: "正文" },
  });
  assert.equal(write.ok, true);
  if (write.ok) {
    assert.equal(write.proposal.tool, "write_note");
    assert.equal(write.proposal.agent, "opencode");
    assert.deepEqual(write.proposal.args, { path: "notes/a.md", content: "正文", mode: "create" });
  }

  const patch = parseBridgeProposal("demo-2", {
    agent: "claude",
    tool: "patch_note",
    args: { input: { path: "notes/a.md", find: "旧", content: "新", index: 0 } },
  });
  assert.equal(patch.ok, true);
  if (patch.ok) {
    assert.deepEqual((patch.proposal.args as any).input, {
      path: "notes/a.md",
      find: "旧",
      content: "新",
      index: 0,
    });
  }

  const knowledge = parseBridgeProposal("demo-3", {
    agent: "agent",
    tool: "add_knowledge",
    args: { input: { title: "标题", content: "正文", tags: ["agent"], links: ["某笔记"] } },
  });
  assert.equal(knowledge.ok, true);
  if (knowledge.ok) {
    assert.equal(knowledge.proposal.tool, "add_knowledge");
    assert.deepEqual(knowledge.proposal.args.input.tags, ["agent"]);
  }
});

test("文件桥 schema：拒绝非法工具、版本、id、字段与 dryRun", () => {
  const badTool = parseBridgeProposal("demo", { agent: "a", tool: "delete_note", args: {} });
  assert.equal(badTool.ok, false);

  const badVersion = parseBridgeProposal("demo", {
    version: 2,
    agent: "a",
    tool: "write_note",
    args: { path: "a.md", content: "" },
  });
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.equal(badVersion.reason, "unsupported_version");

  const badId = parseBridgeProposal("../evil", { agent: "a", tool: "write_note", args: { path: "a.md", content: "" } });
  assert.equal(badId.ok, false);

  const mismatch = parseBridgeProposal("demo", {
    id: "other",
    agent: "a",
    tool: "write_note",
    args: { path: "a.md", content: "" },
  });
  assert.equal(mismatch.ok, false);

  const dryRun = parseBridgeProposal("demo", {
    agent: "a",
    tool: "patch_note",
    args: { input: { path: "a.md", find: "x", content: "y", dryRun: true } },
  });
  assert.equal(dryRun.ok, false);

  const noAnchor = parseBridgeProposal("demo", {
    agent: "a",
    tool: "patch_note",
    args: { input: { path: "a.md", content: "y" } },
  });
  assert.equal(noAnchor.ok, false);

  const badTags = parseBridgeProposal("demo", {
    agent: "a",
    tool: "add_knowledge",
    args: { input: { title: "t", content: "c", tags: [1] } },
  });
  assert.equal(badTags.ok, false);
});

test("文件桥：id/路径解析与 256KB UTF-8 上限", () => {
  assert.equal(isBridgeProposalId("demo-1"), true);
  assert.equal(isBridgeProposalId(".hidden"), false);
  assert.equal(isBridgeProposalId("a".repeat(65)), false);
  assert.equal(bridgeProposalIdFromPath(".obsidian/plugins/sediment/bridge/proposals/demo-1.json"), "demo-1");
  assert.equal(bridgeProposalIdFromPath(".obsidian/plugins/sediment/bridge/proposals/readme.txt"), null);
  assert.equal(bridgePendingId("demo-1"), "bridge-demo-1");
  assert.equal(bridgeTextTooLarge("a".repeat(256 * 1024)), false);
  assert.equal(bridgeTextTooLarge("a".repeat(256 * 1024 + 1)), true);
  assert.equal(bridgeTextTooLarge("中".repeat(90_000)), true);
});

test("文件桥：决策记录字段与截断", () => {
  const decision = buildBridgeDecision({
    id: "demo-1",
    pendingId: "bridge-demo-1",
    decision: "rejected",
    reason: "forbidden",
    agent: "opencode",
    tool: "write_note",
    path: "a.md",
    message: "x".repeat(800),
  });
  assert.equal(decision.version, 1);
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reason, "forbidden");
  assert.equal(decision.message?.length, 500);
  assert.ok(decision.time.includes("T"));
});

test("文件桥导入：auto 模式也强制挂起，采纳后按提案 agent 登记来源", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto", knowledgeFolder: "Sediment/knowledge" });
  const result = await ctx.api.importBridgeProposal({
    id: "demo-1",
    agent: "opencode",
    tool: "write_note",
    args: { path: "Sediment/knowledge/a.md", content: "正文", mode: "create" },
  });
  assert.equal(ctx.files.has("Sediment/knowledge/a.md"), false, "提案不得自动落盘");
  assert.equal(result.pendingId, "bridge-demo-1");
  const record = ctx.pendingWrites[0];
  assert.equal(record.id, result.pendingId);
  assert.equal(record.source, "bridge");
  assert.equal(record.proposalId, "demo-1");
  assert.equal(record.agent, "opencode");
  assert.equal(record.tool, "write_note");
  assert.match(record.after, /agent: "opencode"/);
  await ctx.api.approvePendingWrite(result.pendingId);
  assert.match(ctx.files.get("Sediment/knowledge/a.md") ?? "", /agent: "opencode"/);
});

test("文件桥导入：待审 id 固定为 bridge-<提案 id>，不同提案互不冲突", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const first = await ctx.api.importBridgeProposal({
    id: "poll-1",
    agent: "opencode",
    tool: "write_note",
    args: { path: "notes/one.md", content: "甲", mode: "create" },
  });
  const second = await ctx.api.importBridgeProposal({
    id: "poll-2",
    agent: "claude",
    tool: "write_note",
    args: { path: "notes/two.md", content: "乙", mode: "create" },
  });
  assert.equal(first.pendingId, "bridge-poll-1");
  assert.equal(second.pendingId, "bridge-poll-2");
  assert.deepEqual(
    ctx.pendingWrites.map((item) => item.id).sort(),
    ["bridge-poll-1", "bridge-poll-2"],
    "两个提案必须各自留下独立待审项，且 id 不得是 pw-* 或互相覆盖"
  );
});

test("文件桥导入：patch_note 与 add_knowledge 挂起、预览、采纳", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto" }, { "notes/a.md": "hello world" });
  const patch = await ctx.api.importBridgeProposal({
    id: "p1",
    agent: "claude",
    tool: "patch_note",
    args: { input: { path: "notes/a.md", find: "world", content: "sediment" } },
  });
  assert.equal(ctx.pendingWrites[0].before, "hello world");
  assert.equal(ctx.pendingWrites[0].after, "hello sediment");
  assert.equal(ctx.pendingWrites[0].request.kind, "patch_note");
  await ctx.api.approvePendingWrite(patch.pendingId);
  assert.equal(ctx.files.get("notes/a.md"), "hello sediment");

  const knowledge = await ctx.api.importBridgeProposal({
    id: "k1",
    agent: "opencode",
    tool: "add_knowledge",
    args: { input: { title: "标题", content: "正文" } },
  });
  const knowledgeRecord = ctx.pendingWrites.find((item) => item.id === knowledge.pendingId);
  assert.ok(knowledgeRecord);
  assert.equal(knowledgeRecord.request.kind, "knowledge");
  assert.match(knowledgeRecord.path, /^Sediment\/knowledge\//);
  await ctx.api.approvePendingWrite(knowledge.pendingId);
  assert.match(ctx.files.get(knowledgeRecord.path) ?? "", /agent: opencode/);
});

test("文件桥导入：门禁失败不产生待审项", async () => {
  const denied = fakeConfirmPlugin({ agentWorkMode: "auto", deniedFolders: "secret" });
  await assert.rejects(
    denied.api.importBridgeProposal({
      id: "d1",
      agent: "a",
      tool: "write_note",
      args: { path: "secret/a.md", content: "x", mode: "create" },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN"
  );
  assert.equal(denied.pendingWrites.length, 0);

  const readonly = fakeConfirmPlugin({ agentWorkMode: "auto", agentAllowCreate: false });
  await assert.rejects(
    readonly.api.importBridgeProposal({
      id: "d2",
      agent: "a",
      tool: "write_note",
      args: { path: "notes/a.md", content: "x", mode: "create" },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "OPERATION_DENIED"
  );
  assert.equal(readonly.pendingWrites.length, 0);
});

test("文件桥决策钩子：采纳/驳回写回，MCP 记录不触发", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const calls: Array<{ id: string; decision: string; reason: string }> = [];
  ctx.plugin.fileBridge = {
    notifyDecision: (record: { id: string }, decision: string, reason: string) => {
      calls.push({ id: record.id, decision, reason });
    },
  };

  const approved = await ctx.api.importBridgeProposal({
    id: "a1",
    agent: "agent",
    tool: "write_note",
    args: { path: "notes/a.md", content: "x", mode: "create" },
  });
  await ctx.api.approvePendingWrite(approved.pendingId);
  assert.deepEqual(calls[0], { id: approved.pendingId, decision: "approved", reason: "user_approved" });

  const rejected = await ctx.api.importBridgeProposal({
    id: "r1",
    agent: "agent",
    tool: "write_note",
    args: { path: "notes/b.md", content: "y", mode: "create" },
  });
  ctx.api.rejectPendingWrite(rejected.pendingId);
  assert.deepEqual(calls[1], { id: rejected.pendingId, decision: "rejected", reason: "user_rejected" });

  const mcp = (await ctx.api.writeNote("notes/c.md", "z", "create")) as HoldResult;
  await ctx.api.approvePendingWrite(pendingIdOf(mcp));
  assert.equal(calls.length, 2, "MCP 待审记录不应触发文件桥决策");
});

test("文件桥导入：提案 agent 覆盖 args.input.agent（防冒充）", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto" });
  const result = await ctx.api.importBridgeProposal({
    id: "spoof-1",
    agent: "opencode",
    tool: "add_knowledge",
    args: { input: { title: "冒充测试", content: "正文", agent: "spoofed" } },
  });
  const record = ctx.pendingWrites.find((item) => item.id === result.pendingId);
  assert.ok(record);
  assert.match(record.after, /agent: opencode/);
  assert.doesNotMatch(record.after, /agent: spoofed/);
  await ctx.api.approvePendingWrite(result.pendingId);
  const written = ctx.files.get(record.path) ?? "";
  assert.match(written, /agent: opencode/);
  assert.doesNotMatch(written, /agent: spoofed/);
});

test("文件桥轮询：合法提案导入、非法 JSON/越权写决策、已有决策与待审跳过", async () => {
  const ctx = fakeBridgeHarness();
  ctx.files.set(
    proposalPath("ok-1"),
    JSON.stringify({ agent: "opencode", tool: "write_note", args: { path: "notes/a.md", content: "x" } })
  );
  ctx.files.set(proposalPath("bad-json"), "{not json");
  ctx.files.set(
    proposalPath("decided-1"),
    JSON.stringify({ agent: "a", tool: "write_note", args: { path: "notes/b.md", content: "x" } })
  );
  ctx.files.set(decisionPath("decided-1"), "{}");
  ctx.files.set(
    proposalPath("pending-1"),
    JSON.stringify({ agent: "a", tool: "write_note", args: { path: "notes/c.md", content: "x" } })
  );
  ctx.pendingWrites.push({ id: "bridge-pending-1" });

  await ctx.bridge.scanNow();

  assert.equal(ctx.imported.length, 1);
  assert.equal(ctx.imported[0].id, "ok-1");
  const badDecision = JSON.parse(ctx.files.get(decisionPath("bad-json")) ?? "{}");
  assert.equal(badDecision.reason, "invalid_json");
  assert.equal(ctx.files.has(decisionPath("decided-1")), true);
  assert.equal(ctx.imported.some((item) => item.id === "decided-1"), false);
  assert.equal(ctx.imported.some((item) => item.id === "pending-1"), false);
});

test("文件桥轮询：门禁失败写 rejected 决策且不重复处理", async () => {
  const ctx = fakeBridgeHarness();
  let calls = 0;
  ctx.plugin.agentApi.importBridgeProposal = async () => {
    calls += 1;
    throw new ApiError("FORBIDDEN", "访问被拒绝", 403);
  };
  ctx.files.set(
    proposalPath("denied-1"),
    JSON.stringify({ agent: "a", tool: "write_note", args: { path: "secret/a.md", content: "x" } })
  );

  await ctx.bridge.scanNow();
  await ctx.bridge.scanNow();

  assert.equal(calls, 1, "失败提案不应每轮重试");
  const decision = JSON.parse(ctx.files.get(decisionPath("denied-1")) ?? "{}");
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reason, "forbidden");
  assert.equal(decision.pendingId, "bridge-denied-1");
});

test("文件桥轮询：队列满时不导入、不写决策", async () => {
  const ctx = fakeBridgeHarness();
  for (let index = 0; index < 100; index += 1) ctx.pendingWrites.push({ id: `pw-${index}` });
  ctx.files.set(
    proposalPath("wait-1"),
    JSON.stringify({ agent: "a", tool: "write_note", args: { path: "notes/a.md", content: "x" } })
  );

  await ctx.bridge.scanNow();

  assert.equal(ctx.imported.length, 0);
  assert.equal(ctx.files.has(decisionPath("wait-1")), false);
});

test("文件桥决策：采纳/驳回写回且不覆盖已有决策", async () => {
  const ctx = fakeBridgeHarness();
  const record: Record<string, any> = {
    id: "bridge-demo-9",
    time: new Date().toISOString(),
    tool: "write_note",
    agent: "opencode",
    path: "notes/a.md",
    request: { kind: "write_note", args: {} },
    before: "",
    after: "",
    source: "bridge",
    proposalId: "demo-9",
  };

  ctx.bridge.notifyDecision(record as never, "approved", "user_approved");
  await ctx.bridge.flushNow();
  const decision = JSON.parse(ctx.files.get(decisionPath("demo-9")) ?? "{}");
  assert.equal(decision.decision, "approved");
  assert.equal(decision.reason, "user_approved");
  assert.equal(decision.pendingId, "bridge-demo-9");

  ctx.bridge.notifyDecision(record as never, "rejected", "user_rejected");
  await ctx.bridge.flushNow();
  const stillApproved = JSON.parse(ctx.files.get(decisionPath("demo-9")) ?? "{}");
  assert.equal(stillApproved.decision, "approved", "已有决策不得覆盖");
});

test("文件桥决策：非法 proposalId 不拼接路径、不写决策文件", async () => {
  const ctx = fakeBridgeHarness();
  const record: Record<string, any> = {
    id: "bridge-evil",
    time: new Date().toISOString(),
    tool: "write_note",
    agent: "opencode",
    path: "notes/a.md",
    request: { kind: "write_note", args: {} },
    before: "",
    after: "",
    source: "bridge",
    proposalId: "../evil",
  };

  ctx.bridge.notifyDecision(record as never, "approved", "user_approved");
  await ctx.bridge.flushNow();

  assert.equal([...ctx.files.keys()].some((key) => key.includes("evil")), false, "非法 id 不得落盘");
  assert.ok(ctx.diagnostics.some((item) => item.category === "security"));
});

test("文件桥轮询：同一轮两条非法 JSON 都写决策（链式 flush 不丢条目）", async () => {
  const ctx = fakeBridgeHarness();
  ctx.files.set(proposalPath("bad-a"), "{not json");
  ctx.files.set(proposalPath("bad-b"), "[still not json");

  await ctx.bridge.scanNow();

  assert.equal(ctx.imported.length, 0);
  for (const id of ["bad-a", "bad-b"]) {
    const decision = JSON.parse(ctx.files.get(decisionPath(id)) ?? "{}");
    assert.equal(decision.decision, "rejected", `${id} 决策必须落盘`);
    assert.equal(decision.reason, "invalid_json");
  }
});

test("文件桥轮询：禁用后直接扫描不导入、不写决策", async () => {
  const ctx = fakeBridgeHarness();
  ctx.files.set(
    proposalPath("after-stop"),
    JSON.stringify({ agent: "a", tool: "write_note", args: { path: "notes/stop.md", content: "x" } })
  );

  ctx.bridge.stop();
  await ctx.bridge.scanNow();

  assert.equal(ctx.imported.length, 0, "禁用后不得导入");
  assert.equal(ctx.files.has(decisionPath("after-stop")), false, "禁用后不得写决策");
  assert.equal(ctx.pendingWrites.length, 0);
});

test("Agent 聚合：累计/24h/7d/活跃口径互不混淆，且不受 500 条流水上限影响", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const usage: AgentUsageMap = {};
  recordAgentUsage(usage, "qoder", new Date(now - 2 * 60_000).toISOString(), "search_notes", now);
  recordAgentUsage(usage, "qoder", new Date(now - 3 * 3600_000).toISOString(), "read_note", now);
  recordAgentUsage(usage, "qoder", new Date(now - 3 * 86400_000).toISOString(), "write_note", now);
  recordAgentUsage(usage, "qoder", new Date(now - 10 * 86400_000).toISOString(), "patch_note", now);
  const stat = usage.qoder;
  assert.equal(stat.total, 4, "累计数包含所有历史，即使小时/日期桶已过期");
  assert.equal(recentHourCount(stat, now), 2, "24h 只算当前小时与之前 23 个小时桶");
  assert.equal(recentDayCount(stat, now), 3, "7d 只算今天及之前 6 个本地日期");
  assert.equal(isAgentActive(stat, now), true, "2 分钟内调用过应视为活跃");
  assert.equal(stat.lastTool, "search_notes", "最近工具取时间最新的一次");
  assert.equal(totalAgentCalls(usage), 4);
});

test("Agent 聚合：超过 5 分钟不算活跃，空名字归到未署名键", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const usage: AgentUsageMap = {};
  recordAgentUsage(usage, "", new Date(now - 6 * 60_000).toISOString(), "list_notes", now);
  assert.equal(isAgentActive(usage[""], now), false);
  const summary = summarizeAgentUsage(usage, now);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].agent, "", "空 agent 保持独立键，由渲染层显示为未署名客户端");
  assert.equal(summary[0].active, false);
});

test("Agent 聚合：摘要按最近调用倒序，重建时取最新一条作为最近工具", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const older = new Date(now - 3600_000).toISOString();
  const newer = new Date(now - 60_000).toISOString();
  const usage = rebuildAgentUsage(
    [
      { time: newer, tool: "write_note", agent: "cursor", path: "" },
      { time: older, tool: "read_note", agent: "qoder", path: "" },
    ],
    now
  );
  assert.equal(usage.qoder.total, 1);
  assert.equal(usage.cursor.lastTool, "write_note");
  const summary = summarizeAgentUsage(usage, now);
  assert.deepEqual(summary.map((item) => item.agent), ["cursor", "qoder"]);
});

test("Agent 聚合：持久化形状异常时回退重建，单条坏数据被跳过", () => {
  assert.equal(sanitizeAgentUsage(null), null);
  assert.equal(sanitizeAgentUsage([]), null);
  const salvaged = sanitizeAgentUsage({
    qoder: { total: 3, lastAt: "x", lastTool: "search_notes", hours: { "1": 2 }, days: { "2026-11-21": 1 } },
    broken: { total: "3" },
  });
  assert.deepEqual(Object.keys(salvaged ?? {}), ["qoder"]);
  assert.deepEqual(salvaged?.qoder.hours, { "1": 2 });
});

test("Store.load：旧数据缺少聚合字段时按现有流水重建", async () => {
  const fakePlugin = {
    loadData: async () => ({
      version: 1,
      toolCalls: [
        { time: new Date().toISOString(), tool: "search_notes", agent: "qoder", path: "" },
      ],
    }),
  } as unknown as ConstructorParameters<typeof Store>[0];
  const store = new Store(fakePlugin);
  await store.load();
  assert.equal(store.data.agentUsage.qoder.total, 1);
  assert.equal(store.data.agentUsage.qoder.lastTool, "search_notes");
});

test("i18n：连接与调用状态卡新增英文条目已收录", () => {
  setLocale("en");
  try {
    assert.equal(t("客户端"), "Clients");
    assert.equal(t("近 24 小时"), "Last 24 hours");
    assert.equal(t("5 分钟内调用过"), "Active in the last 5 min");
    assert.equal(t("未署名客户端"), "Unattributed client");
  } finally {
    setLocale("zh");
  }
});
