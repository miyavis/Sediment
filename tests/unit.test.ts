import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice, TFile, type Plugin } from "obsidian";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBridgePath } from "../src/agent/setup";
import { BRIDGE_SOURCE } from "../src/agent/bridge-source";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_SETTINGS,
  type DayRecord,
  type FocusSessionRecord,
  type MemoRecord,
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
import { Store } from "../src/data/store";
import { AgentApi, ApiError, safeAgentPath } from "../src/agent/api";
import { SemanticIndex, tokenizeSemanticText } from "../src/agent/semantic";
import { tokensMatch } from "../src/agent/server";
import { idempotencyKey, redactAuditPath, redactSecrets } from "../src/agent/security";
import { computeDiff } from "../src/ui/diff-modal";
import { barChart, mean, referenceLines, ring } from "../src/utils/charts";
import {
  inferCategory,
  isOperationAllowed,
  isPathAllowedByMode,
  isPathDenied,
  isSafePathSegmentName,
  listCategories,
  splitList,
} from "../src/agent/access";

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

  const recoveryPath = await store.restoreDataBackup(backupName);

  assert.ok(recoveryPath.startsWith(".obsidian/plugins/sediment/recovery/data-"));
  const copy = written.find(([p]) => p === recoveryPath);
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

test("H6：delegateTask 需要 read 权限且受白名单约束", async () => {
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
  await assert.doesNotReject(api.delegateTask("知识/a.md", 2));
  assert.equal(calls.delegate.length, 1);
});

test("H6：snapshotTasks 写当天日记前过 patch 门禁", async () => {
  const { api, calls } = fakeAgentPlugin({ deniedFolders: "daily", agentAllowPatch: true });
  await assert.rejects(api.snapshotTasks(), (error) => {
    const e = asApiError(error);
    return e.code === "FORBIDDEN";
  });
  assert.equal(calls.snapshot.length, 0, "被拒绝时不得写日记");

  const noPatch = fakeAgentPlugin({ agentAllowPatch: false });
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
  return { api: new AgentApi(plugin as never), tasks: plugin.tasks as TaskManager, store, pendingWrites, diagnostics, files: fileStore };
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