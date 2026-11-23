// views — 从 unit.test.ts 拆出，helpers 来自 ../helpers
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
  assert.equal(h.manager.state().running, false); // 禁用后 start 会先接管，不直接启动
  assert.equal(h.manager.state().disabled, false, "toggle/start 路径可显式接管恢复");
  assert.notEqual(h.store.data.pomodoro?.instanceId, "other-instance", "接管后写入本实例标识");

  const stale = pomodoroHarness({ ...saved, heartbeatAt: now - 120_000 }, now);
  assert.equal(stale.manager.state().disabled, false); // 心跳过期 → 接管
  assert.notEqual(stale.store.data.pomodoro?.instanceId, "other-instance"); // 接管立即写入本实例标识
  assert.equal(stale.store.data.pomodoro?.heartbeatAt, now); // 心跳立即刷新，接管窗口近零
});

test("pomodoro：正常退出标记后快速重启立即接管，不再误判为另一存活实例", () => {
  const now = new Date(2026, 10, 20, 9, 0, 0).getTime();
  const key = "sediment:pomodoro-released:test-vault";
  const saved: PersistedPomodoro = {
    mode: "focus",
    remaining: 1500,
    running: false,
    completed: 0,
    savedAt: now - 11_000,
    instanceId: "previous-instance",
    heartbeatAt: now - 11_000,
  };
  const storage = memoryStorage({ [key]: "previous-instance" });
  const h = pomodoroHarness(saved, now, storage);
  assert.equal(h.manager.state().disabled, false); // 正常退出不算存活
  assert.notEqual(h.store.data.pomodoro?.instanceId, "previous-instance"); // 新实例接管
  assert.equal(h.store.data.pomodoro?.heartbeatAt, now);
  assert.equal(storage.getItem(key), null); // 标记用后清除
});

test("pomodoro：卸载时只有当前持有者写释放标记，禁用实例不碰对方状态", () => {
  const now = new Date(2026, 10, 20, 9, 0, 0).getTime();
  const key = "sediment:pomodoro-released:test-vault";

  const ownerStorage = memoryStorage();
  const owner = pomodoroHarness(null, now, ownerStorage);
  owner.manager.start();
  const ownerId = owner.store.data.pomodoro?.instanceId;
  owner.manager.shutdown();
  assert.equal(ownerStorage.getItem(key), ownerId);
  assert.equal(owner.store.data.pomodoro?.heartbeatAt, 0); // 同步失效，异步保存失败也能兜底

  const disabledStorage = memoryStorage();
  const disabled = pomodoroHarness(
    {
      mode: "focus",
      remaining: 1500,
      running: false,
      completed: 0,
      savedAt: now - 5_000,
      instanceId: "other-instance",
      heartbeatAt: now - 5_000,
    },
    now,
    disabledStorage
  );
  disabled.manager.shutdown();
  assert.equal(disabledStorage.getItem(key), null);
  assert.equal(disabled.store.data.pomodoro?.instanceId, "other-instance"); // 不覆盖对方
  assert.equal(disabled.store.data.pomodoro?.heartbeatAt, now - 5_000);
});

test("memo：id 锚点兜底——日记正文被手动改过后编辑仍同步且不留孤儿", async () => {
  const h = memoHarness();
  const memo = await h.manager.add("original line", ["a"]);
  assert.ok(memo);
  const path = `Sediment/daily/${dateKey(new Date())}.md`;
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
  const path = `Sediment/daily/${dateKey(new Date())}.md`;

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

test("EN locale：周复盘生成内容零 CJK（zh 下仍为中文）", () => {
  const fakeStore = {
    settings: settings(),
    data: {
      memos: [
        { id: "m1", date: dateKey(new Date()), time: "10:00", text: "english memo", tags: [], converted: false },
      ],
    },
    getDay: () => day({ contribution: 5 }),
  } as never;
  setLocale("en");
  try {
    const md = buildWeeklyReview(fakeStore, new Date());
    assert.equal(/[\u4e00-\u9fff]/.test(md), false, md);
    assert.match(md, /Weekly review|review/i);
  } finally {
    setLocale("zh");
  }
  const zh = buildWeeklyReview(fakeStore, new Date());
  assert.match(zh, /工作复盘/);
});

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
    { time: "2026-11-20T11:00:00.000Z", tool: "POST write_note", agent: "a", path: "held.md", held: true }, // 挂起中未落盘
  ];
  const reviewed = { "2026-11-20T06:00:00.000Z|done.json": "kept" as const };
  const pending = pendingReviewChanges(calls, reviewed);
  assert.deepEqual(pending.map((call) => call.path), ["n.md"]);
  assert.equal(reviewBadgeCount({ drafts: 0, changes: pending.length, pendingWrites: 0 }), 1);
});

test("pendingChangeRows：目标缺失仍保留一行并标记 missing，徽章与列表不漂移", () => {
  const calls = [
    { time: "2026-11-21T10:06:52.895Z", tool: "POST note", agent: "a", path: "old/template.md" },
    { time: "2026-11-21T10:06:43.602Z", tool: "POST note", agent: "a", path: "keep.md" },
  ];
  const rows = pendingChangeRows(calls, {}, (path) => path === "keep.md");
  assert.deepEqual(rows.map((row) => row.call.path), ["old/template.md", "keep.md"]);
  assert.deepEqual(rows.map((row) => row.missing), [true, false]);
  assert.equal(rows.length, reviewBadgeCount({ drafts: 0, changes: rows.length, pendingWrites: 0 }));
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
    const store = new Store({ loadData: async () => raw } as unknown as ConstructorParameters<typeof Store>[0]);
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
    const store = new Store({ loadData: async () => raw } as unknown as ConstructorParameters<typeof Store>[0]);
    await store.load();
    assert.match(store.migrationWarning ?? "", /不支持的数据版本 99/);
  } finally {
    setLocale(prev);
  }
});

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

test("A1：addMemo/delegateTask 的日记目标路径过完整门禁（黑名单/白名单/confirm 前置）", async () => {
  // auto 档 + 黑名单 daily：速记与转 Agent 都必须 403，且不产生任何副作用。
  const denied = fakeAgentPlugin({ deniedFolders: DEFAULT_SETTINGS.dailyNoteFolder }, { data: { memos: [] } });
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
  const confirm = fakeConfirmPlugin({ agentWorkMode: "confirm", deniedFolders: DEFAULT_SETTINGS.dailyNoteFolder });
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
  ctx.store.settings.deniedFolders = DEFAULT_SETTINGS.dailyNoteFolder;
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
  const fresh = fakeVault([{ path: `Sediment/backups/${backupName}`, mtime: 200, size: backupContent.length }]);
  fresh.written.push([`Sediment/backups/${backupName}`, backupContent]);
  const freshCtx = fakePluginWith(fresh.vault, null);
  const freshStore = new Store(freshCtx.plugin);
  await freshStore.load();
  const none = await freshStore.restoreDataBackup(backupName);
  assert.deepEqual(none, { recoveryPath: "", recovery: "none" });
  assert.equal(freshStore.getDay("2026-11-19").wordsAdded, 42, "none 分支仍须完成恢复");

  // 副本写失败：恢复继续，但必须显式标记 failed 并留下诊断（不静默吞错）。
  const failing = fakeVault([{ path: `Sediment/backups/${backupName}`, mtime: 200, size: backupContent.length }]);
  failing.written.push([`Sediment/backups/${backupName}`, backupContent]);
  const failCtx = fakePluginWith(failing.vault, { version: 1, days: {} });
  const failStore = new Store(failCtx.plugin);
  await failStore.load();
  failing.vault.adapter.write = async () => { throw new Error("permission denied"); };
  // 恢复完成后 load() 会以备份内容重建 diagnostics，故用 spy 断言失败当时已记录。
  const diagnosticCalls: string[] = [];
  const originalLog = failStore.logDiagnostic.bind(failStore);
  failStore.logDiagnostic = (category: string, message: string, detail?: string, schedule?: boolean) => {
    diagnosticCalls.push(message);
    originalLog(category as Parameters<typeof originalLog>[0], message, detail, schedule);
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
  } as unknown as ConstructorParameters<typeof Store>[0];
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

test("第 5 项：AgentServer HTTP 契约——仅 Authorization 头鉴权、?token= 失效、413、400 非法 URL", async () => {
  const port = 28653;
  const diagnostics: Array<{ category: string; message: string }> = [];
  const plugin = {
    store: {
      settings: { agentServerEnabled: true, agentServerPort: port, agentServerToken: "unit-token" },
      logDiagnostic: (category: string, message: string) => { diagnostics.push({ category, message }); },
      toolCalls: [] as Array<Record<string, unknown>>,
      dropToolCall: (call: Record<string, unknown>) => {
        const index = (plugin.store as any).toolCalls.indexOf(call);
        if (index >= 0) (plugin.store as any).toolCalls.splice(index, 1);
      },
    },
    agentApi: {
      logToolCall: (tool: string, agent: string, path: string) => {
        const record = { time: new Date().toISOString(), tool, agent, path };
        (plugin.store as any).toolCalls.unshift(record);
        return record;
      },
      callMeta: (tool: string, agent: string, call: any) => ({ tool, agent, call }),
    },
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

    // 写请求返回 400（非法 mode）时，已入队的审计行必须撤回（F4）。
    const badModeBody = JSON.stringify({ path: "a.md", content: "x", mode: "nonsense" });
    const badMode = await rawHttp(
      port,
      `POST /note HTTP/1.1\r\n${host}Authorization: Bearer unit-token\r\nContent-Type: application/json\r\nContent-Length: ${badModeBody.length}\r\n\r\n${badModeBody}`
    );
    assert.match(badMode, /^HTTP\/1\.1 400/);
    assert.match(badMode, /INVALID_MODE/);

    assert.equal(
      (plugin.store as any).toolCalls.length,
      0,
      "GET / 401 / 400 / 413 / 404 / 写请求失败 都不得留下审计行"
    );
  } finally {
    await server.stop();
  }
});

test("B3：escapeAttr 导出复用——& < > 双引号全量转义", () => {
  assert.equal(escapeAttr('a&b<c>d"e'), "a&amp;b&lt;c&gt;d&quot;e");
  assert.equal(escapeAttr(""), "");
});
