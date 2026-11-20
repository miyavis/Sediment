import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice } from "obsidian";
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
  hhmm,
  localHHmm,
  localStamp,
  isSameLocalDay,
} from "../src/utils/dates";
import { countWords, countCheckedTasks, noteDateKey } from "../src/tracking/tracker";
import { normalizeFolder } from "../src/utils/vault";
import { buildStatsCsv, buildExportJson, DEFAULT_EXPORT_OPTIONS } from "../src/features/export";
import { Store } from "../src/data/store";
import { ApiError, safeAgentPath } from "../src/agent/api";
import { tokenizeSemanticText } from "../src/agent/semantic";
import { idempotencyKey, redactAuditPath, redactSecrets } from "../src/agent/security";
import { computeDiff } from "../src/ui/diff-modal";
import { barChart, mean, referenceLines, ring } from "../src/utils/charts";
import {
  inferCategory,
  isOperationAllowed,
  isPathAllowedByMode,
  isPathDenied,
  listCategories,
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