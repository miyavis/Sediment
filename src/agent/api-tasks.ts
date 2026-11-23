/** AgentApi 的任务方法（list/complete/delegate/snapshot/claim/complete_agent）。
 *  混入到 AgentApi 原型，对外 API 不变；confirm 挂起与门禁复用类的公开委托方法。 */

import { TFile } from "obsidian";
import { t, tf } from "../i18n";
import { dailyNotePath, parseKey } from "../utils/dates";
import { toggleCheckboxLine } from "../features/tasks";
import { isPathAllowedByMode } from "./access";
import type { MemoRecord } from "../types";
import { ApiError, safeAgentPath } from "./api";
import type { AgentApi, WithPending, AgentPendingResult, WriteMeta } from "./api";

export interface TaskMethods {
  listTasks(scope?: string): Promise<Array<{ path: string; line: number; text: string; date: string; checked: boolean }>>;
  completeTask(path: string, line: number, bypassConfirm?: boolean, meta?: WriteMeta): Promise<WithPending<{ ok: true }>>;
  delegateTask(path: string, line: number, bypassConfirm?: boolean, meta?: WriteMeta): Promise<WithPending<{ id: string }>>;
  snapshotTasks(bypassConfirm?: boolean, meta?: WriteMeta): Promise<WithPending<{ count: number }>>;
  claimAgentTask(id: string, bypassAccess?: boolean, meta?: WriteMeta): Promise<MemoRecord | AgentPendingResult>;
  completeAgentTask(id: string, resultPath?: string, bypassAccess?: boolean, meta?: WriteMeta): Promise<MemoRecord | AgentPendingResult>;
}

export const taskMethods: TaskMethods = {
  async listTasks(this: AgentApi, scope = "all") {
    const settings = this.plugin.store.settings;
    return this.plugin.tasks.list(scope as "today" | "overdue" | "all" | "agent", {
      accessible: (target: string) => !target || isPathAllowedByMode(target, settings),
    });
  },

  async completeTask(this: AgentApi, path: string, line: number, bypassConfirm = false, meta?: WriteMeta) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "patch");
    if (!bypassConfirm && this.isConfirmMode()) {
      const file = this.vault.getAbstractFileByPath(safe);
      const before = file instanceof TFile ? await this.vault.read(file) : "";
      const after = before.split("\n").map((item, index) => (index === line - 1 ? toggleCheckboxLine(item) : item)).join("\n");
      return this.holdForConfirm("complete_task", safe, "task_complete", { path: safe, line }, before, after, meta);
    }
    this.plugin.tracker.markAgentWrite(safe);
    await this.plugin.tasks.complete(safe, line);
    return { ok: true as const };
  },

  async delegateTask(this: AgentApi, path: string, line: number, bypassConfirm = false, meta?: WriteMeta) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "read");
    const daily = dailyNotePath(this.plugin.store.settings, new Date());
    const dailyExists = this.vault.getAbstractFileByPath(daily) instanceof TFile;
    this.assertPathAllowed(daily, dailyExists ? "patch" : "create");
    if (!bypassConfirm && this.isConfirmMode()) {
      const tasks = await this.plugin.tasks.list("all");
      const task = tasks.find((item) => item.path === safe && item.line === line);
      if (!task) throw new ApiError("NOT_FOUND", tf("找不到待办：{path}:{line}", { path: safe, line }), 404);
      return this.holdForConfirm(
        "delegate_task", daily, "memo",
        { text: task.text, tags: ["to-agent"], sourcePath: safe, sourceLine: line },
        "", tf("记一条速记到 {path}", { path: daily }) + `\n${task.text}\n标签：#to-agent`, meta
      );
    }
    return { id: await this.plugin.tasks.delegate(safe, line) };
  },

  async snapshotTasks(this: AgentApi, bypassConfirm = false, meta?: WriteMeta) {
    const settings = this.plugin.store.settings;
    const now = new Date();
    const path = dailyNotePath(settings, now);
    const dailyExists = this.vault.getAbstractFileByPath(path) instanceof TFile;
    this.assertPathAllowed(path, dailyExists ? "patch" : "create");
    const accessible = (target: string): boolean => isPathAllowedByMode(target, settings);
    if (!bypassConfirm && this.isConfirmMode()) {
      const overdue = await this.plugin.tasks.list("overdue", { accessible });
      const summary = overdue.length
        ? tf("将 {n} 条遗留待办写入 {path}", { n: overdue.length, path })
        : t("没有需要记录的遗留待办");
      return this.holdForConfirm("snapshot_tasks", path, "task_snapshot", {}, "", summary, meta);
    }
    return { count: await this.plugin.tasks.snapshot({ accessible, date: now }) };
  },

  async claimAgentTask(this: AgentApi, id: string, bypassAccess = false, meta?: WriteMeta) {
    const memo = this.plugin.store.data.memos.find((item) => item.id === id);
    if (!memo) throw new Error(`速记不存在：${id}`);
    if (!memo.tags.includes("to-agent")) throw new Error(`速记 ${id} 不是待办任务`);
    if (!bypassAccess) {
      const target = dailyNotePath(this.plugin.store.settings, parseKey(memo.date));
      this.assertPathAllowed(target, "patch");
      if (!meta?.hold && !meta?.replay && this.isConfirmMode()) {
        return this.holdForConfirm(
          "claim_agent_task", target, "claim_agent_task", { id }, "",
          tf("认领 Agent 任务：{text}", { text: memo.text }), meta
        );
      }
    }
    memo.tags = memo.tags.filter((tag) => tag !== "to-agent");
    if (!memo.tags.includes("agent-in-progress")) memo.tags.push("agent-in-progress");
    this.plugin.store.scheduleSave();
    await this.plugin.memos.syncTags(memo);
    return memo;
  },

  async completeAgentTask(this: AgentApi, id: string, resultPath?: string, bypassAccess = false, meta?: WriteMeta) {
    const memo = this.plugin.store.data.memos.find((item) => item.id === id);
    if (!memo) throw new Error(`速记不存在：${id}`);
    if (!bypassAccess) {
      const target = dailyNotePath(this.plugin.store.settings, parseKey(memo.date));
      this.assertPathAllowed(target, "patch");
      if (!meta?.hold && !meta?.replay && this.isConfirmMode()) {
        return this.holdForConfirm(
          "complete_agent_task", target, "complete_agent_task", { id, resultPath }, "",
          tf("完成 Agent 任务：{text}", { text: memo.text }), meta
        );
      }
    }
    memo.tags = memo.tags.filter((tag) => tag !== "to-agent" && tag !== "agent-in-progress" && tag !== "agent-done");
    memo.tags.push("agent-done");
    memo.converted = true;
    if (resultPath) memo.resultPath = resultPath;
    this.plugin.store.scheduleSave();
    await this.plugin.memos.syncTags(memo);
    return memo;
  },
};
