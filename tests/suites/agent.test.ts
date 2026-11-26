// agent — 从 unit.test.ts 拆出，helpers 来自 ../helpers
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
import { AgentApi, ApiError, safeAgentPath, stampAgentProvenance, generateToken } from "../../src/agent/api";
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
  const matrix: Array<["create" | "overwrite" | "delete", keyof SedimentSettings]> = [
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
  assert.ok(ok.calls.complete.length === 1 && ((ok.calls.complete[0] as unknown[])[0] as string) === "公开/a.md");
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
    agentAllowedFolders: `知识, ${DEFAULT_SETTINGS.dailyNoteFolder}`,
    agentAllowRead: true,
  });
  await assert.doesNotReject(ok.api.delegateTask("知识/a.md", 2));
  assert.equal(ok.calls.delegate.length, 1);
});

test("H6：snapshotTasks 写当天日记前过 patch 门禁", async () => {
  const { api, calls } = fakeAgentPlugin({ deniedFolders: DEFAULT_SETTINGS.dailyNoteFolder, agentAllowPatch: true });
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
        vault: { getAbstractFileByPath: (p: string) => (p === existingDaily ? new TFileWithPath(p) : null) },
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

test("addKnowledge：frontmatter 值中的换行被单行化，防注入（3.3）", async () => {
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
        create: async (p: string, c: string) => { created.push({ path: p, content: c }); return new TFileStub(p); },
      },
      metadataCache: { getFileCache: () => undefined },
    },
    tracker: { markAgentWrite: () => {} },
  };
  const api = new AgentApi(plugin as never);
  await api.addKnowledge({
    title: "测试",
    content: "正文",
    category: "技术\n恶意字段: injected",
    agent: "evil\nSediment_status: accepted",
  });
  const content = created[0].content;
  // 不得出现被注入的独立 frontmatter 行。
  assert.doesNotMatch(content, /^恶意字段: injected$/m);
  assert.doesNotMatch(content, /^Sediment_status: accepted$/m);
  const fm = content.split("---")[1];
  // 换行被替换为空格，仍在单行内。
  assert.match(fm, /category: 技术/);
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

  const knowledgeRoot = DEFAULT_SETTINGS.knowledgeFolder;
  const evil = await api.addKnowledge({ title: "沉淀", content: "正文", category: "../../evil" });
  assert.ok(!evil.path.includes(".."), `路径不得含 ..：${evil.path}`);
  assert.ok(evil.path.startsWith(`${knowledgeRoot}/技术/`), `应回退到默认分类：${evil.path}`);
  assert.ok(evil.note && evil.note.length > 0, "返回信息需说明分类被回退");

  const good = await api.addKnowledge({ title: "沉淀", content: "正文", category: "方法" });
  assert.ok(good.path.startsWith(`${knowledgeRoot}/方法/`));
  assert.equal(good.note, undefined);
  assert.equal(created.length, 2, "两次调用都应真实落盘");
});

test("令牌比较：SHA-256 定长 + timingSafeEqual，长度不等不抛异常", () => {
  assert.equal(tokensMatch("secret-token", "secret-token"), true);
  assert.equal(tokensMatch("secret-token", "secret-tokeX"), false);
  assert.equal(tokensMatch("short", "much-longer-token"), false);
  assert.equal(tokensMatch("", ""), true);
});

test("generateToken：CSPRNG 不可用时抛错而非弱化随机（A7）", () => {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  const original = cryptoObj?.getRandomValues?.bind(cryptoObj);
  try {
    if (cryptoObj) {
      (cryptoObj as { getRandomValues: unknown }).getRandomValues = () => {
        throw new Error("no cspng");
      };
    } else {
      (globalThis as { crypto?: unknown }).crypto = {
        getRandomValues: () => { throw new Error("no cspng"); },
      };
    }
    assert.throws(() => generateToken());
  } finally {
    if (cryptoObj && original) {
      (cryptoObj as { getRandomValues: unknown }).getRandomValues = original;
    } else {
      delete (globalThis as { crypto?: unknown }).crypto;
    }
  }
  // 正常路径生成 32 位十六进制令牌。
  const token = generateToken();
  assert.match(token, /^[0-9a-f]{32}$/);
});

test("getActiveContext：白名单外与禁访标签笔记不得泄露正文", () => {
  function pluginFor(settingsOverride: Record<string, unknown>) {
    const activeFile = new TFileStub("其他/私密.md");
    return {
      store: { settings: { ...DEFAULT_SETTINGS, ...settingsOverride } },
      app: {
        workspace: {
          getActiveFile: () => activeFile,
          getLeavesOfType: () => [],
          activeEditor: {
            editor: {
              getSelection: () => "选中文本",
              getCursor: () => ({ line: 0, ch: 0 }),
              getLine: () => "正文",
              lineCount: () => 1,
              getRange: () => "正文段落",
            },
          },
        },
        metadataCache: {
          getFileCache: (f: { path: string }) =>
            f.path === "其他/私密.md" && (settingsOverride as { denyTag?: boolean }).denyTag
              ? { tags: [{ tag: "#secret" }], frontmatter: {} }
              : undefined,
        },
      },
    } as never;
  }

  // allowlist 模式、文件不在白名单 → 拒绝
  const outside = new AgentApi(
    pluginFor({ agentAccessMode: "allowlist", agentAllowedFolders: "知识" })
  );
  assert.equal(outside.getActiveContext().file, null);

  // 命中黑/白名单 → 放行
  const allowed = new AgentApi(
    pluginFor({ agentAccessMode: "allowlist", agentAllowedFolders: "其他" })
  );
  assert.equal(allowed.getActiveContext().file, "其他/私密.md");

  // 带禁访标签 → 拒绝（即使路径在白名单内）
  const tagged = new AgentApi(
    pluginFor({ agentAccessMode: "allowlist", agentAllowedFolders: "其他", denyTag: true, deniedTags: "secret" })
  );
  assert.equal(tagged.getActiveContext().file, null);
});

test("写路径：目标文件带禁止标签时 assertPathAllowed 拒绝（A3）", () => {
  // obsidian.d.ts 声明 TFile 无参构造；测试桩接受 path，运行时 instanceof 需要真实桩类。
  const file = new (TFile as unknown as new (path: string) => TFile)("笔记/secret.md");
  const plugin = {
    store: {
      settings: { ...DEFAULT_SETTINGS, deniedTags: "secret", agentAccessMode: "allow-all" },
      logDiagnostic: () => {},
    },
    app: {
      vault: { getAbstractFileByPath: (p: string) => (p === "笔记/secret.md" ? file : null) },
      metadataCache: { getFileCache: () => ({ tags: [{ tag: "#secret" }], frontmatter: {} }) },
    },
  } as never;
  const api = new AgentApi(plugin);
  assert.throws(
    () => api.assertPathAllowed("笔记/secret.md", "overwrite"),
    (e: unknown) => e instanceof ApiError && e.code === "FORBIDDEN"
  );
  // 读路径不应因本守卫抛错（标签门禁在读路径另有实现）。
  assert.doesNotThrow(() => api.assertPathAllowed("笔记/secret.md", "read"));
});

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
  const auditData = (ctx.store as unknown as {
    data: { toolCalls: Array<{ path: string }>; reviewedChanges: Record<string, unknown> };
  }).data;
  assert.ok(Object.keys(auditData.reviewedChanges).length > 0, "采纳后自动标记调用已审查，不再需要二次点击");

  const second = (await ctx.api.writeNote("notes/b.md", "x", "create")) as HoldResult;
  ctx.api.rejectPendingWrite(pendingIdOf(second));
  assert.equal(ctx.files.has("notes/b.md"), false);
  assert.equal(ctx.pendingWrites.length, 0);
  assert.equal(auditData.toolCalls.filter((c) => c.path === "notes/b.md").length, 0, "驳回后不留幽灵调用行");
  assert.ok(ctx.diagnostics.some((d) => d.category === "security" && /驳回并丢弃/.test(d.message)));
  // 驳回与采纳都要在审计时间线永久留痕（C1/C2）。
  assert.ok((ctx.store as { data: { writeDecisions: unknown[] } }).data.writeDecisions.some((d) => (d as { decision: string }).decision === "rejected"));
  assert.ok((ctx.store as { data: { writeDecisions: unknown[] } }).data.writeDecisions.some((d) => (d as { decision: string }).decision === "approved"));

  assert.throws(() => ctx.api.rejectPendingWrite("nope"), (error) => asApiError(error).code === "NOT_FOUND");
  await assert.rejects(ctx.api.approvePendingWrite("nope"), (error) => asApiError(error).code === "NOT_FOUND");

  // 顺序契约：权限检查 → confirm 拦截。黑名单目录直接 403，不产生挂起项。
  const denied = fakeConfirmPlugin({ agentWorkMode: "confirm", deniedFolders: "notes" });
  await assert.rejects(denied.api.writeNote("notes/c.md", "x"), (error) => asApiError(error).code === "FORBIDDEN");
  assert.equal(denied.pendingWrites.length, 0, "越权写入不得转挂起");
});

test("confirm 档：挂起后目标内容被改 → 采纳报 CONTENT_CHANGED，不落盘且保留待审", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "原文\n" });
  const held = (await ctx.api.writeNote("notes/a.md", "新文", "overwrite")) as HoldResult;
  const id = pendingIdOf(held);
  assert.ok(ctx.pendingWrites[0].beforeHash, "挂起时记录 before 哈希");
  ctx.files.set("notes/a.md", "被人改过\n");
  await assert.rejects(
    ctx.api.approvePendingWrite(id),
    (error) => asApiError(error).code === "CONTENT_CHANGED"
  );
  assert.equal(ctx.files.get("notes/a.md"), "被人改过\n", "不得覆盖人工修改");
  assert.equal(ctx.pendingWrites.length, 1, "被拒后保留待审项供驳回");

  // 新建类：挂起后目标被抢先创建也不能覆盖。
  const ctx2 = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const held2 = (await ctx2.api.writeNote("notes/b.md", "x", "create")) as HoldResult;
  ctx2.files.set("notes/b.md", "抢先创建");
  await assert.rejects(
    ctx2.api.approvePendingWrite(pendingIdOf(held2)),
    (error) => asApiError(error).code === "CONTENT_CHANGED"
  );
});

test("confirm 档：并发请求各自结算调用流水；同一待审并发采纳只落盘一次", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const callA = ctx.store.logToolCall({
    time: new Date().toISOString(), tool: "POST /note", agent: "alice", path: "notes/a.md",
  });
  const callB = ctx.store.logToolCall({
    time: new Date().toISOString(), tool: "POST /note", agent: "bob", path: "notes/b.md",
  });
  const heldA = (await ctx.api.writeNote("notes/a.md", "A", "create", false,
    ctx.api.callMeta("POST /note", "alice", callA))) as HoldResult;
  const heldB = (await ctx.api.writeNote("notes/b.md", "B", "create", false,
    ctx.api.callMeta("POST /note", "bob", callB))) as HoldResult;
  assert.equal(callA.pendingId, pendingIdOf(heldA), "A 的调用绑定 A 的待审");
  assert.equal(callB.pendingId, pendingIdOf(heldB), "B 的调用绑定 B 的待审");

  const [first, second] = await Promise.allSettled([
    ctx.api.approvePendingWrite(pendingIdOf(heldA)),
    ctx.api.approvePendingWrite(pendingIdOf(heldA)),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") {
    assert.equal(asApiError(second.reason).code, "PENDING_IN_FLIGHT");
  }
  assert.equal(ctx.files.get("notes/a.md"), "A", "不得重复落盘");
  assert.ok((ctx.files.get("notes/a.md") || "").indexOf("B") < 0);
});

test("confirm 档：claim/completeAgentTask 挂起不直接改标签；addKnowledge 反斜杠逃逸被拒", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, {
    "Sediment/daily/2026-11-21.md": "---\ndate: 2026-11-21\n---\n- [ ] x\n",
  });
  const memo = {
    id: "m1", date: "2026-11-21", time: "10:00", text: "交给 agent", tags: ["to-agent"],
    converted: false,
  };
  ctx.store.data.memos.push(memo);
  const held = (await ctx.api.claimAgentTask("m1")) as HoldResult;
  assert.ok(held.pending);
  assert.deepEqual(memo.tags, ["to-agent"], "挂起期间不得直接改标签");
  await ctx.api.approvePendingWrite(pendingIdOf(held));
  assert.ok(memo.tags.includes("agent-in-progress"), "采纳后才改标签");

  const heldDone = (await ctx.api.completeAgentTask("m1")) as HoldResult;
  assert.ok(heldDone.pending);
  await ctx.api.approvePendingWrite(pendingIdOf(heldDone));
  assert.ok(memo.tags.includes("agent-done"));

  await assert.rejects(
    ctx.api.addKnowledge({ title: "x", content: "y", folder: "..\\..\\evil" }),
    (error) => asApiError(error).code === "FORBIDDEN"
  );
});

test("confirm 档：从 data.json 恢复的挂起写入仍可按原请求重放落盘", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/x.md": "旧内容\n" });
  // 模拟重启后从 data.json 载入的待审项（内容与哈希已冻结）。
  ctx.pendingWrites.push({
    id: "pw-restored", time: new Date().toISOString(), tool: "write_note", agent: "qoder",
    path: "notes/x.md", request: { kind: "write_note", args: { path: "notes/x.md", content: "重启后落盘", mode: "overwrite" } },
    before: "旧内容\n", beforeHash: contentHash("旧内容\n"), after: "重启后落盘", expectAbsent: false,
  });
  await ctx.api.approvePendingWrite("pw-restored");
  assert.equal(ctx.files.get("notes/x.md"), "重启后落盘");
  assert.equal(ctx.pendingWrites.length, 0);
});

test("confirm 档：挂起写入只算待审，不重复计入变更审查；采纳转入审查，驳回不留痕", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" });
  const call = ctx.store.logToolCall({
    time: new Date().toISOString(), tool: "POST /note", agent: "qoder", path: "notes/a.md",
  });
  const meta = ctx.api.callMeta("POST /note", "qoder", call);
  const held = (await ctx.api.writeNote("notes/a.md", "内容", "create", false, meta)) as HoldResult;
  assert.equal(call.held, true);
  assert.equal(call.pendingId, ctx.pendingWrites[0].id);
  assert.equal(pendingReviewChanges(ctx.store.data.toolCalls, {}).length, 0, "挂起期间不进变更审查");
  assert.equal(reviewBadgeCount({ drafts: 0, changes: 0, pendingWrites: 1 }), 1, "同一次写入只计 1");

  await ctx.api.approvePendingWrite(pendingIdOf(held));
  assert.equal(ctx.store.data.toolCalls.length, 1);
  assert.equal(ctx.store.data.toolCalls[0].held, undefined, "采纳后解除挂起");
  assert.deepEqual(
    pendingReviewChanges(ctx.store.data.toolCalls, {}).map((item) => item.path),
    ["notes/a.md"],
    "采纳后转入变更审查，保留回滚入口"
  );

  const call2 = ctx.store.logToolCall({
    time: new Date().toISOString(), tool: "POST /note", agent: "qoder", path: "notes/b.md",
  });
  const meta2 = ctx.api.callMeta("POST /note", "qoder", call2);
  const rejected = (await ctx.api.writeNote("notes/b.md", "x", "create", false, meta2)) as HoldResult;
  ctx.api.rejectPendingWrite(pendingIdOf(rejected));
  assert.equal(
    ctx.store.data.toolCalls.some((item: Record<string, any>) => item.path === "notes/b.md"),
    false,
    "驳回后移除挂起调用，不留幽灵行"
  );
  assert.equal(pendingReviewChanges(ctx.store.data.toolCalls, {}).length, 1);
});

test("stampAgentProvenance：补登记来源；已有 source 不覆盖；幂等", () => {
  const stamped = stampAgentProvenance("# 标题\n正文", "qoder", "2026-11-21");
  assert.match(stamped, /^---\n/);
  assert.match(stamped, /source: "agent"/);
  assert.match(stamped, /sediment_status: "draft"/);
  assert.match(stamped, /agent: "qoder"/);
  assert.ok(stamped.includes("# 标题\n正文"));
  assert.equal(stampAgentProvenance(stamped, "other", "2026-11-22"), stamped, "幂等");
  const human = "---\nsource: human\n---\nbody";
  assert.equal(stampAgentProvenance(human, "qoder", "2026-11-21"), human, "已有 source 不覆盖");
  const unclosed = "---\n正文";
  assert.equal(stampAgentProvenance(unclosed, "qoder", "2026-11-21"), unclosed, "未闭合 frontmatter 不抛错、不 stamp");
});

test("writeNote：知识目录内新建自动登记来源，预览即含 frontmatter；目录外不 stamp", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm", knowledgeFolder: "knowledge" });
  const held = (await ctx.api.writeNote("knowledge/技术/x.md", "# 标题\n正文", "create")) as HoldResult;
  pendingIdOf(held);
  assert.match(ctx.pendingWrites[0].after, /source: "agent"/, "挂起预览就应看到登记属性");
  await ctx.api.approvePendingWrite(ctx.pendingWrites[0].id);
  assert.match(ctx.files.get("knowledge/技术/x.md") ?? "", /sediment_status: "draft"/);

  const plain = (await ctx.api.writeNote("notes/y.md", "纯文本", "create")) as HoldResult;
  pendingIdOf(plain);
  assert.equal(ctx.pendingWrites[0].after, "纯文本", "知识目录外不 stamp");
});

test("writeNote：auto 档知识目录直写也带来源属性", async () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "auto", knowledgeFolder: "knowledge" });
  await ctx.api.writeNote("knowledge/项目/z.md", "内容", "create");
  assert.match(ctx.files.get("knowledge/项目/z.md") ?? "", /source: "agent"/);
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
  const draftPath = `${DEFAULT_SETTINGS.knowledgeFolder}/d.md`;
  const draftRes = (await draft.api.writeNote(draftPath, "草稿")) as HoldResult;
  assert.equal(draftRes.pending, undefined, "draft 档写入直接落盘（草稿流），不挂起");
  // 知识目录内的新建笔记会自动补登记来源 frontmatter（任务 6），正文仍原样落盘。
  const draftDoc = draft.files.get(draftPath) ?? "";
  assert.match(draftDoc, /source: "agent"/);
  assert.ok(draftDoc.endsWith("草稿"), "正文不得被 stamp 改动");
  await assert.rejects(draft.api.patchNote({ path: draftPath, find: "草稿", content: "y" }), (error) => asApiError(error).code === "OPERATION_DENIED");

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
  const logPath = `Sediment/agent-logs/${dateKey(new Date())}.md`;
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
  const taskFile = { "notes/a.md": "- [ ] 交给agent #task\n- [ ] 别的\n" };

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
  } as unknown as ConstructorParameters<typeof Store>[0];
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
  } as unknown as ConstructorParameters<typeof Store>[0];
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

test("TaskManager.listGrouped：一次全库扫描同时给出今日/遗留/Agent 三组", async () => {
  const today = dateKey(new Date());
  const ctx = fakeConfirmPlugin({}, {
    [`Sediment/daily/${today}.md`]: "- [ ] 今日\n- [x] 已完成\n",
    "Sediment/daily/2020-01-01.md": "- [ ] 遗留\n",
  });
  ctx.plugin.app.vault.cachedRead = async (f: { path: string }) => {
    (ctx.plugin as any).reads = ((ctx.plugin as any).reads ?? 0) + 1;
    return (ctx.files as Map<string, string>).get(f.path) ?? "";
  };
  ctx.store.data.memos.push({
    id: "m1", date: today, time: "10:00", text: "委派任务", tags: ["to-agent"], converted: false,
  });
  const groups = await ctx.tasks.listGrouped();
  assert.deepEqual(groups.today.map((t) => t.text), ["今日", "已完成"]);
  assert.deepEqual(groups.overdue.map((t) => t.text), ["遗留"]);
  assert.deepEqual(groups.agent.map((t) => t.text), ["委派任务"]);
  assert.equal((ctx.plugin as any).reads, 2, "两篇笔记各只读一次，而不是三次全库扫描");
});

test("待办来源：只扫日记与 #task 笔记，模板和知识笔记验收清单不进入待办", async () => {
  const today = dateKey(new Date());
  const ctx = fakeConfirmPlugin({}, {
    [`Sediment/daily/${today}.md`]: "- [ ] 日记待办\n",
    "Templates/知识笔记模板.md": "#task\n- [ ] 模板占位\n",
    "Sediment/knowledge/灵感/旧片.md": "---\ntype: knowledge\n---\n- [ ] 验收项\n",
    "Sediment/knowledge/灵感/新片.md": "---\ntype: knowledge\n---\n#task\n- [ ] 显式任务\n",
    "项目/甲.md": "#task\n- [ ] 项目待办\n",
  });

  const all = await ctx.tasks.list("all");
  assert.deepEqual(
    all.map((item) => item.text),
    ["日记待办", "显式任务", "项目待办"],
    "日记默认纳入；知识笔记只有 #task 才纳入；模板永远不纳入"
  );
  assert.ok(!all.some((item) => item.text === "验收项"), "知识笔记里的验收清单不得混入待办");
  assert.ok(!all.some((item) => item.text === "模板占位"), "模板占位复选框不得混入待办");

  const todayTasks = await ctx.tasks.list("today");
  assert.deepEqual(todayTasks.map((item) => item.text), ["日记待办"]);
});

test("移交项 1：越权目录待办不进入 Agent listTasks / snapshotTasks，人用 UI 不过滤", async () => {
  const files = {
    "Sediment/daily/2020-01-01.md": "- [ ] 公开待办\n",
    "私有/2020-01-01.md": "#task\n- [ ] 私密待办\n",
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
    "Sediment/daily/2020-01-01.md": "- [ ] 公开待办\n",
    "私有/2020-01-01.md": "#task\n- [ ] 私密待办\n",
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
