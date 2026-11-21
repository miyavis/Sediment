import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice, TFile, type Plugin } from "obsidian";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { contentHash } from "../src/utils/hash";
/** obsidian 类型里的 TFile 构造函数无参；测试假实现接受路径，做显式类型桥接。 */
export const TFileWithPath = TFile as unknown as new (path: string) => TFile;
import { configureAgent, configSnippet, isAgentConfigured, resolveBridgePath } from "../src/agent/setup";
import * as setupNs from "../src/agent/setup";
import { BRIDGE_SOURCE } from "../src/agent/bridge-source";
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
import { countWords, countCheckedTasks, noteDateKey, Tracker } from "../src/tracker";
import { PomodoroManager, type PomodoroStorage } from "../src/features/pomodoro";
import { MemoManager } from "../src/features/memo";
import { buildWeeklyReview } from "../src/features/review";
import SedimentPlugin from "../src/main";
import { normalizeFolder } from "../src/utils/vault";
import { TaskManager } from "../src/features/tasks";
import { buildStatsCsv, buildExportJson, DEFAULT_EXPORT_OPTIONS } from "../src/features/export";
import { todayLine } from "../src/features/embed";
import { Store } from "../src/data/store";
import {
  isAgentActive,
  rebuildAgentUsage,
  recentDayCount,
  recentHourCount,
  recordAgentUsage,
  sanitizeAgentUsage,
  summarizeAgentUsage,
  totalAgentCalls,
} from "../src/data/agent-usage";
import { AgentApi, ApiError, safeAgentPath, stampAgentProvenance } from "../src/agent/api";
import { FileBridge } from "../src/features/file-bridge";
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
  pendingChangeRows,
  pendingReviewChanges,
  reviewBadgeCount,
} from "../src/views/dashboard/review-queue";
import { SETTINGS_SECTIONS, settingsSection } from "../src/ui/settings-sections";
import {
  OllamaEmbeddingClient,
  cosineSimilarity,
  hashText,
  normalizeEndpoint,
  type RequestFn,
} from "../src/agent/embedding";
import { renderYearly } from "../src/views/dashboard/sections/insights";
import { scanKnowledgeState, type KnowledgeFile } from "../src/features/knowledge-state";
import { delegateHealthIssues, HEALTH_LABEL, scanNoteHealth } from "../src/features/health";
import {
  LEGACY_FOLDER_MIGRATIONS,
  migrateLegacyFolders,
  planFolderMigrations,
} from "../src/features/folder-migration";
import {
  bridgePendingId,
  bridgeProposalIdFromPath,
  bridgeTextTooLarge,
  buildBridgeDecision,
  isBridgeProposalId,
  parseBridgeProposal,
} from "../src/agent/bridge-schema";

export const day = (partial: Partial<DayRecord> = {}): DayRecord => ({ ...createEmptyDay(), ...partial });
export const settings = (partial: Partial<PulseSettings> = {}): PulseSettings => ({
  ...DEFAULT_SETTINGS,
  ...partial,
});





















export const accessSettings = {
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















/** 构造一个仅含导出所需字段的假 Store。 */
export function fakeStore(): Store {
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
    getDay: (key: string) => (days as Record<string, DayRecord>)[key] ?? createEmptyDay(),
  } as unknown as Store;
}







// ---------- OpenCode v1/v2 一键配置适配 ----------

export type LayoutFn = (data: Record<string, unknown>, probe?: () => number | undefined) => "v1" | "v2";
export function layoutFn(): LayoutFn {
  const fn = (setupNs as unknown as { detectOpenCodeLayout?: LayoutFn }).detectOpenCodeLayout;
  assert.equal(typeof fn, "function", "setup.ts 应导出 detectOpenCodeLayout");
  return fn as LayoutFn;
}

export function fakeSetupPlugin(tmp: string) {
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

export function openCodeTarget(cfgPath: string) {
  return { id: "opencode", name: "OpenCode", configPath: cfgPath, rootKey: "mcp" as const, envKey: "environment" as const };
}
















// ---------- 存储层可靠性（Task 5） ----------

/** 构造带 adapter/getFiles/trash 的假 vault，记录写入与删除。 */
export function fakeVault(files: Array<{ path: string; mtime?: number; size?: number }> = []) {
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
    configDir: ".obsidian",
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

export function fakePluginWith(vault: ReturnType<typeof fakeVault>["vault"], raw: unknown) {
  let current = raw;
  const saved: unknown[] = [];
  const plugin = {
    loadData: async () => current,
    saveData: async (data: unknown) => { saved.push(data); current = data; },
    app: {
      vault,
      fileManager: {
        trashFile: async (file: { path: string }) => {
          await (vault as unknown as { trash: (f: { path: string }) => Promise<void> }).trash(file);
        },
      },
    },
  };
  return { plugin: plugin as unknown as ConstructorParameters<typeof Store>[0], saved };
}























// ---------------------------------------------------------------------------
// 权限统一门禁（v0.9.7 评审修复 H6/H7/M1/M3 + 令牌恒定时间比较）
// ---------------------------------------------------------------------------

/** 构造只够跑门禁路径的假 SedimentPlugin（拒绝分支不触碰 vault）。
 * 这些用例验证权限层，默认钉在 auto 档（无 confirm 挂起，通过即直接落盘）。 */
export function fakeAgentPlugin(partial: Partial<PulseSettings> = {}, extra: Record<string, unknown> = {}) {
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

export class TFileStub {
  path: string;
  basename: string;
  stat = { ctime: 0, mtime: 0, size: 0 };
  constructor(p: string) {
    this.path = p;
    this.basename = p.split("/").pop() ?? "";
  }
}

export const asApiError = (error: unknown): ApiError => {
  assert.ok(error instanceof ApiError, `应抛 ApiError，实际：${String(error)}`);
  return error;
};













// ---------------------------------------------------------------------------
// confirm 工作模式真实现（Task 4）+ Task 3 移交验收项
// ---------------------------------------------------------------------------

export type HoldResult = { path?: string; pending?: true; pendingId?: string; message?: string; count?: number };

/** 内存版 vault：足够跑通 writeNote/patchNote/frontmatter/日记类落盘与读路径。 */
export function memoryVault(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const asFile = (p: string) => new TFileWithPath(p);
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
export function fakeConfirmPlugin(partial: Partial<PulseSettings> = {}, files: Record<string, string> = {}) {
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
    logToolCall: (record: Record<string, any>) => {
      store.data.toolCalls.unshift(record);
      return record;
    },
    markToolCallHeld: (call: Record<string, any> | null, pendingId: string) => {
      if (!call) return;
      call.held = true;
      call.pendingId = pendingId;
    },
    releaseToolCall: (pendingId: string) => {
      const call = store.data.toolCalls.find(
        (item: Record<string, any>) => item.pendingId === pendingId && item.held
      );
      if (!call) return false;
      delete call.held;
      return true;
    },
    dropPendingToolCall: (pendingId: string) => {
      const index = store.data.toolCalls.findIndex(
        (item: Record<string, any>) => item.pendingId === pendingId && item.held
      );
      if (index < 0) return false;
      store.data.toolCalls.splice(index, 1);
      return true;
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

export const pendingIdOf = (result: HoldResult): string => {
  assert.ok(result.pending, `应挂起为待审：${JSON.stringify(result)}`);
  assert.ok(result.pendingId);
  return result.pendingId;
};





















// ---------------------------------------------------------------------------
// Task 6：统计与特性正确性（可注入时钟 / Obsidian 桩的行为测试）
// ---------------------------------------------------------------------------

export const newTFile = TFile as unknown as new (path: string) => TFile;
export const noticeMessages = (Notice as unknown as { messages: string[] }).messages;

/** 手动推进的假时钟：驱动去抖与 Agent 抑制窗口，不依赖真实时间。 */
export function fakeClock(start: number) {
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
export function trackerHarness(
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




/** pomodoro 行为测试桩：可注入 clock、setInterval 与释放标记存储。 */
export function pomodoroHarness(
  saved: PersistedPomodoro | null = null,
  start = new Date(2026, 10, 20, 9, 0, 0).getTime(),
  storage?: PomodoroStorage
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
    app: { vault: { getName: () => "test-vault" } },
    addStatusBarItem: () => ({ setText: () => {} }),
    registerInterval: () => {},
  };
  const manager = new PomodoroManager(plugin as unknown as SedimentPlugin, {
    now: () => now,
    setInterval: (fn) => {
      tickFn = fn;
      return 0;
    },
    storage,
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

/** 内存版 localStorage：验证正常退出标记的读写与清除。 */
export function memoryStorage(initial: Record<string, string> = {}): PomodoroStorage & {
  keys: Map<string, string>;
} {
  const keys = new Map(Object.entries(initial));
  return {
    keys,
    getItem: (key) => keys.get(key) ?? null,
    setItem: (key, value) => {
      keys.set(key, value);
    },
    removeItem: (key) => {
      keys.delete(key);
    },
  };
}






/** memo 行为测试桩：内存 vault + 现有 Obsidian 桩。 */
export function memoHarness() {
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




// ── 阶段二 Task 9：周复盘英文化 ──


// ── Task 7：页签契约与设置 IA（审核队列纯函数口径 + 设置分区数据） ──






// ── Task 8：i18n 防再犯扫描器自测 ──










// ── Task 8：图表可访问性（role/aria-label/图例标签） ──





// ── Task 8：启动 Notice 语言顺序（Task 5 移交项） ──




// ── Task 9：月度地层聚合（纯函数） ──









// ── Task 10 第一轮：代码加固 ─────────────────────────────────────────────








/** 原生 socket 发一条 HTTP 请求并收完整响应（Connection: close 保证 end 触发）。 */
export function rawHttp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    socket.on("data", (chunk) => { data += String(chunk); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("raw http timeout")));
  });
}



// ---------------------------------------------------------------------------
// Task 10 第二轮：清理 / 文档 / 工具（C2 嵌入文案、C3 EN 月份补零）
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 全分支终审单轮修复：claim/complete 日记门禁、recordWorkLog/snapshotTasks
// 按存在性选操作、年轮图 i18n 与可访问性
// ---------------------------------------------------------------------------

/** 往 fakeConfirmPlugin 里塞一条当天 #to-agent 速记，返回该 memo 供副作用断言。 */
export function seedAgentMemo(ctx: ReturnType<typeof fakeConfirmPlugin>) {
  const memo = {
    id: "m1", date: dateKey(new Date()), time: "00:00", text: "任务",
    tags: ["to-agent"], converted: false,
  };
  ctx.store.data.memos.push(memo);
  return memo;
}






// ── 阶段二 Task 12：上架准备 ──


// ── 阶段一 Task 1：待审写入轻量对账 ──

export const pendingRecord = (partial: Partial<PendingWriteRecord> = {}): PendingWriteRecord => ({
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




// ── 阶段一 Task 2：采纳守卫 + main.ts 对账接线 ──



// ── 阶段一 Task 3：工坊失效待审 UI ──


// ── 阶段一 Task 4：知识库现状纯函数 ──



// ── 阶段一 Task 5：看板「知识库现状」卡 ──


// ── 阶段一 Task 7：工坊「来源未登记」卡 + 标记为人工 ──


// ── 阶段二 Task 8：健康度六项 ──

export function fakeHealthPlugin(
  files: Array<{ path: string; mtime?: number; size?: number; frontmatter?: Record<string, unknown> }>,
  links: { resolved?: Record<string, Record<string, number>>; unresolved?: Record<string, Record<string, number>> } = {},
  partial: Partial<PulseSettings> = {}
) {
  const entries = files.map((entry) => {
    const file = new TFileWithPath(entry.path);
    file.stat = { ctime: 0, mtime: entry.mtime ?? Date.now(), size: entry.size ?? 100 };
    return { file, frontmatter: entry.frontmatter };
  });
  const byPath = new Map(entries.map((entry) => [entry.file.path, entry]));
  return {
    store: { settings: settings(partial) },
    app: {
      vault: { getMarkdownFiles: () => entries.map((entry) => entry.file) },
      metadataCache: {
        resolvedLinks: links.resolved ?? {},
        unresolvedLinks: links.unresolved ?? {},
        getFileCache: (file: TFile) => {
          const frontmatter = byPath.get(file.path)?.frontmatter;
          return frontmatter ? { frontmatter } : undefined;
        },
      },
    },
  } as never;
}



// ── 阶段二 Task 10：知识笔记 / 工作日志 / 健康任务英文化 ──




// ── 阶段二 Task 11：检索标题英文化 ──


// ── 阶段三 Task 14：Embedding 设置项 + 客户端 ──




// ── 阶段三 Task 15：SemanticIndex embedding 集成 ──

export function fakeSemanticPlugin(files: Record<string, string>, partial: Partial<PulseSettings> = {}) {
  const { store: fileStore, vault } = memoryVault(files);
  const diagnostics: Array<{ category: string; message: string }> = [];
  const plugin = {
    store: {
      settings: settings(partial),
      logDiagnostic: (category: string, message: string) => {
        diagnostics.push({ category, message });
      },
    },
    app: { vault, metadataCache: { getFileCache: () => undefined } },
  } as never;
  return { plugin, fileStore, diagnostics };
}

export const fakeEmbed: RequestFn = async (options) => {
  const body = JSON.parse(options.body ?? "{}") as { input: string[] };
  return {
    status: 200,
    json: {
      embeddings: body.input.map((text) =>
        text.includes("apple") ? [1, 0] : text.includes("banana") ? [0, 1] : [0.5, 0.5]
      ),
    },
  };
};





// ── 默认目录收进 Sediment/ 与旧目录一键迁移 ──



/** 迁移测试桩：路径集合 + 可失败 renameFile + 可列目录/删空目录的 adapter。 */
export function migrationHarness(initial: string[], failOnPath = "") {
  const paths = new Map<string, { path: string }>(initial.map((p) => [p, { path: p }]));
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  // 真实 vault 里空目录会保留到 rmdir；这里同样单独跟踪目录集合。
  const folders = new Set<string>();
  const addParents = (p: string) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  };
  for (const p of paths.keys()) addParents(p);
  const list = async (folder: string) => {
    const prefix = `${folder}/`;
    const files = [...paths.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
    const children = [...folders].filter(
      (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")
    );
    return { files, folders: children };
  };
  const vault = {
    getFiles: () => [...paths.values()],
    getAbstractFileByPath: (p: string) =>
      paths.get(p) ?? (folders.has(p) ? { path: p, children: [] } : null),
    createFolder: async (p: string) => {
      if (paths.has(p) || folders.has(p)) throw new Error(`already exists: ${p}`);
      folders.add(p);
    },
    adapter: {
      list,
      rmdir: async (folder: string) => {
        const listing = await list(folder);
        if (listing.files.length > 0 || listing.folders.length > 0) throw new Error(`not empty: ${folder}`);
        folders.delete(folder);
        removed.push(folder);
      },
    },
  };
  const fileManager = {
    renameFile: async (file: { path: string }, to: string) => {
      if (to === failOnPath) throw new Error("disk full");
      if (paths.has(to)) throw new Error(`already exists: ${to}`);
      // 真实 Obsidian 的 vault.rename 直接走 fs.rename，不创建目标父目录：缺目录即 ENOENT。
      const slash = to.lastIndexOf("/");
      if (slash >= 0 && !folders.has(to.slice(0, slash))) {
        throw new Error(`ENOENT: no such file or directory, rename '${file.path}' -> '${to}'`);
      }
      paths.delete(file.path);
      renamed.push([file.path, to]);
      file.path = to;
      paths.set(to, file);
      addParents(to);
    },
  };
  return { vault, fileManager, renamed, removed, paths, folders };
}

















export function fakeBridgeHarness() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
    exists: async (p: string) => files.has(p) || dirs.has(p),
    mkdir: async (p: string) => {
      dirs.add(p);
    },
    list: async (p: string) => {
      const prefix = `${p}/`;
      return {
        files: [...files.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")),
        folders: [...dirs].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")),
      };
    },
    read: async (p: string) => {
      const value = files.get(p);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    write: async (p: string, data: string) => {
      files.set(p, data);
    },
    rename: async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error("missing");
      files.delete(from);
      files.set(to, value);
    },
    remove: async (p: string) => {
      files.delete(p);
    },
  };
  const pendingWrites: Array<Record<string, any>> = [];
  const diagnostics: Array<{ category: string; message: string; detail?: string }> = [];
  const imported: any[] = [];
  const plugin: Record<string, any> = {
    manifest: { id: "sediment", dir: ".obsidian/plugins/sediment" },
    app: { vault: { configDir: ".obsidian", adapter } },
    store: {
      settings: { ...DEFAULT_SETTINGS, fileBridgeEnabled: true },
      data: { pendingWrites },
      logDiagnostic: (category: string, message: string, detail?: string) => {
        diagnostics.push({ category, message, detail });
      },
    },
    agentApi: {
      importBridgeProposal: async (proposal: any) => {
        imported.push(proposal);
        return { pendingId: `bridge-${proposal.id}`, path: proposal.tool === "write_note" ? proposal.args.path : "x" };
      },
    },
    refreshViews: () => {},
  };
  const bridge = new FileBridge(plugin as never);
  return { bridge, plugin, files, dirs, pendingWrites, diagnostics, imported };
}

export const proposalPath = (id: string) =>
  `.obsidian/plugins/sediment/bridge/proposals/${id}.json`;
export const decisionPath = (id: string) =>
  `.obsidian/plugins/sediment/bridge/decisions/${id}.json`;








// ── 连接与调用状态：按客户端聚合（低成本方案） ──







