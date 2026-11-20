import { test } from "node:test";
import assert from "node:assert/strict";
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
import { Notice, TFile, type Plugin } from "obsidian";
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
function trackerHarness(initial: Record<string, string>) {
  const clock = fakeClock(new Date(2026, 10, 20, 9, 0, 0).getTime());
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