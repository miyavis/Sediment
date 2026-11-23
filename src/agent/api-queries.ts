/** AgentApi 的只读查询/状态方法：混入到 AgentApi 原型，对外 API 不变。
 *  只依赖公开成员（this.plugin / this.vault / 其他委托方法），故可用 this: AgentApi。 */

import { TFile } from "obsidian";
import { buildWeeklyReview } from "../features/review";
import { buildChangeTimeline } from "../features/change-timeline";
import type { DayRecord, MemoRecord, ToolCallRecord, WorkLogRecord } from "../types";
import { addDays, dateKey, lastNDays, parseKey } from "../utils/dates";
import { restoreBackup } from "../features/audit";
import { normalizeFolder } from "../utils/vault";
import { ApiError, safeAgentPath } from "./api";
import type {
  AgentApi,
  DailyContext,
  TodaySnapshot,
} from "./api";

export interface QueryMethods {
  getStats(days?: number): Array<DayRecord & { date: string }>;
  getToday(): TodaySnapshot;
  getActiveContext(): { file: string | null; selection: string; cursorLine: number; cursorParagraph: string };
  semanticSearch(query: string, limit?: number): Promise<Array<{ path: string; score: number; snippet: string }>>;
  logToolCall(tool: string, agent: string, path: string): ToolCallRecord;
  getToolActivity(): { total: number; byTool: Record<string, number>; byAgent: Record<string, number>; recent: Array<{ time: string; tool: string; agent: string; path: string }> };
  getChangeTimeline(limit?: number, agent?: string, path?: string): ReturnType<typeof buildChangeTimeline>;
  getCategories(): { categories: string[]; counts: Record<string, number> };
  getPomodoro(): ReturnType<AgentApi["getPomodoro"]>;
  controlPomodoro(action: string): ReturnType<AgentApi["controlPomodoro"]>;
  getMemos(limit?: number): MemoRecord[];
  getBacklog(): { count: number };
  listWorkLogs(days?: number): WorkLogRecord[];
  getDailyContext(days?: number): DailyContext;
  generateWeeklyReview(date?: string): { date: string; markdown: string };
  getAgentChanges(limit?: number): Array<{ id: string; path: string; time: string; tool: string; agent: string }>;
  revertAgentChange(snapshotId: string): Promise<{ path: string; reverted: true }>;
}

export const queryMethods: QueryMethods = {
  getStats(this: AgentApi, days = 30): Array<DayRecord & { date: string }> {
    const count = Math.max(1, Math.min(days, 370));
    return lastNDays(count).map((date) => ({ date, ...this.plugin.store.getDay(date) }));
  },

  getToday(this: AgentApi): TodaySnapshot {
    const store = this.plugin.store;
    const date = dateKey(new Date());
    const day = store.getDay(date);
    let streak = 0;
    let cursor = new Date();
    if (store.getDay(dateKey(cursor)).contribution === 0) cursor = new Date(cursor.getTime() - 86400000);
    while (store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    const todayMemos = store.data.memos.filter((memo) => memo.date === date);
    return {
      date,
      contribution: day.contribution,
      active: day.contribution > 0,
      streak,
      notesCreated: day.notesCreated,
      wordsAdded: day.wordsAdded,
      tasksCompleted: day.tasksCompleted,
      memos: todayMemos.length,
      backlog: store.data.memos.filter((memo) => !memo.converted && !memo.archived).length,
      focusMinutes: day.focusMinutes,
      focusSource: day.focusMinutes > 0 ? "measured" : "none",
    };
  },

  getActiveContext(this: AgentApi) {
    const workspace = this.plugin.app.workspace;
    let file = workspace.getActiveFile();
    if (!file) {
      const leaf = workspace
        .getLeavesOfType("markdown")
        .find((item) => Boolean((item.view as { file?: TFile | null }).file));
      file = (leaf?.view as { file?: TFile | null } | undefined)?.file ?? null;
    }
    const editor = workspace.activeEditor?.editor;
    if (!file || this.isDeniedPath(file.path) || !this.isAllowedByMode(file.path) || this.hasDeniedTag(file)) {
      return { file: null, selection: "", cursorLine: 0, cursorParagraph: "" };
    }
    const selection = editor?.getSelection() ?? "";
    const cursor = editor?.getCursor() ?? { line: 0, ch: 0 };
    let cursorParagraph = "";
    if (editor) {
      let start = cursor.line;
      let end = cursor.line;
      while (start > 0 && editor.getLine(start - 1).trim() !== "") start -= 1;
      while (end < editor.lineCount() - 1 && editor.getLine(end + 1).trim() !== "") end += 1;
      cursorParagraph = editor.getRange(
        { line: start, ch: 0 },
        { line: end, ch: editor.getLine(end).length }
      );
    }
    return { file: file.path, selection, cursorLine: cursor.line + 1, cursorParagraph };
  },

  async semanticSearch(this: AgentApi, query: string, limit = 10) {
    return this.plugin.semantic.search(String(query ?? ""), limit);
  },

  logToolCall(this: AgentApi, tool: string, agent: string, path: string) {
    return this.plugin.store.logToolCall({ time: new Date().toISOString(), tool, agent, path });
  },

  getToolActivity(this: AgentApi) {
    const byTool: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const call of this.plugin.store.data.toolCalls) {
      byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
      byAgent[call.agent || "unknown"] = (byAgent[call.agent || "unknown"] ?? 0) + 1;
    }
    return {
      total: this.plugin.store.data.toolCalls.length,
      byTool,
      byAgent,
      recent: this.plugin.store.data.toolCalls.slice(0, 20),
    };
  },

  getChangeTimeline(this: AgentApi, limit = 50, agent?: string, path?: string) {
    return buildChangeTimeline(this.plugin.store.data, { limit, agent, path });
  },

  getCategories(this: AgentApi) {
    const counts: Record<string, number> = {};
    const base = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    for (const file of this.vault.getMarkdownFiles()) {
      if (!base || !file.path.startsWith(`${base}/`)) continue;
      const parts = file.path.split("/");
      const category = parts.length > 1 ? parts[1] : "未分类";
      counts[category] = (counts[category] ?? 0) + 1;
    }
    const all = [...new Set([...this.categories(), ...Object.keys(counts)])];
    return { categories: all, counts };
  },

  getPomodoro(this: AgentApi) {
    return this.plugin.pomodoro.state();
  },

  controlPomodoro(this: AgentApi, action: string) {
    const pomodoro = this.plugin.pomodoro;
    if (action === "start") pomodoro.start();
    else if (action === "pause") pomodoro.pause();
    else if (action === "reset") pomodoro.reset();
    else if (action === "skip") pomodoro.skip();
    else pomodoro.toggle();
    return pomodoro.state();
  },

  getMemos(this: AgentApi, limit = 20): MemoRecord[] {
    return this.plugin.store.data.memos.slice(0, Math.max(1, Math.min(limit, 200)));
  },

  getBacklog(this: AgentApi) {
    return { count: this.plugin.store.data.memos.filter((memo) => !memo.converted && !memo.archived).length };
  },

  listWorkLogs(this: AgentApi, days = 7): WorkLogRecord[] {
    const count = Math.max(1, Math.min(days, 370));
    const since = dateKey(addDays(new Date(), -(count - 1)));
    return this.plugin.store.data.workLogs.filter((log) => log.date >= since);
  },

  getDailyContext(this: AgentApi, days = 7): DailyContext {
    return {
      generatedAt: dateKey(new Date()),
      today: this.getToday(),
      backlog: this.getBacklog().count,
      workLogs: this.listWorkLogs(days),
      memos: this.getMemos(10),
      notes: this.listNotes("", 10),
      agentTasks: this.plugin.store.data.memos.filter(
        (memo) => memo.tags.includes("to-agent") && !memo.converted && !memo.archived
      ),
      pendingWrites: (this.plugin.store.data.pendingWrites ?? []).length,
    };
  },

  generateWeeklyReview(this: AgentApi, date?: string) {
    const anchor = date ? parseKey(date) : new Date();
    return { date: dateKey(anchor), markdown: buildWeeklyReview(this.plugin.store, anchor) };
  },

  getAgentChanges(this: AgentApi, limit = 20) {
    return this.plugin.store.data.snapshots.slice(0, Math.max(1, Math.min(limit, 100)));
  },

  async revertAgentChange(this: AgentApi, snapshotId: string) {
    const snapshot = this.plugin.store.data.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) throw new ApiError("NOT_FOUND", `快照不存在：${snapshotId}`, 404);
    const safe = safeAgentPath(snapshot.path, this.vault.configDir);
    this.assertPathAllowed(safe, "overwrite");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new ApiError("NOT_FOUND", `笔记不存在：${safe}`, 404);
    await restoreBackup(this.plugin, file, snapshotId);
    return { path: safe, reverted: true as const };
  },
};
