/** 审核队列的纯函数口径：页签徽章计数、待审变更过滤、Agent 待办子集。
 *  不依赖 obsidian / DOM，供渲染层与单测共用，避免徽章与卡片数量漂移。 */
import type { ToolCallRecord } from "../../types";

export interface ReviewQueueCounts {
  drafts: number;
  changes: number;
  pendingWrites: number;
}

/** Agent 页签徽章 = 草稿 + 待审变更 + 待审写入之和；为 0（或非法输入）时不显示。 */
export function reviewBadgeCount(counts: Partial<ReviewQueueCounts> | null | undefined): number {
  if (!counts) return 0;
  const parts = [counts.drafts ?? 0, counts.changes ?? 0, counts.pendingWrites ?? 0];
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  return parts.reduce((sum, part) => sum + part, 0);
}

export interface PendingChangeRow {
  call: ToolCallRecord;
  /** 目标文件已不存在（删除/移动）。仍保留一行，供 UI 展示并手动标记审查。 */
  missing: boolean;
}

export interface RecentChangeRow extends PendingChangeRow {
  /** 已审查的变更仍保留可见，以便回看差异与恢复；只是不计入待审徽章。 */
  reviewed: boolean;
}

/** 最近变更：按路径去重后列出全部写入调用（含已审查），供「Agent 变更审查」展示差异/恢复入口。
 *  待审徽章仍用 pendingReviewChanges 只数未审查项。 */
export function recentChangeRows(
  calls: ToolCallRecord[],
  reviewed: Record<string, unknown>,
  exists: (path: string) => boolean
): RecentChangeRow[] {
  const seen = new Set<string>();
  return calls
    .filter((call) => call.tool.startsWith("POST ") && call.path && !seen.has(call.path) && seen.add(call.path))
    .filter((call) => /\.(md|json)$/.test(call.path))
    .map((call) => ({
      call,
      missing: !exists(call.path),
      reviewed: Boolean(reviewed[`${call.time}|${call.path}`]),
    }));
}

/** 变更审查行：在待审集合上附加目标存在性。exists 由调用方注入，保持纯函数可测。
 *  目标缺失的旧记录不能静默丢弃，否则徽章计数会大于列表可见行（孤儿记录）。 */
export function pendingChangeRows(
  calls: ToolCallRecord[],
  reviewed: Record<string, unknown>,
  exists: (path: string) => boolean
): PendingChangeRow[] {
  return pendingReviewChanges(calls, reviewed).map((call) => ({
    call,
    missing: !exists(call.path),
  }));
}

/** 待审的 Agent 变更：POST 调用、按路径去重、仅 md/json、排除已审查（kept/reverted）。
 *  confirm 档挂起中的调用（held）尚未落盘，只在「待审写入」出现，不在这里重复计数。 */
export function pendingReviewChanges(
  calls: ToolCallRecord[],
  reviewed: Record<string, unknown>
): ToolCallRecord[] {
  const seen = new Set<string>();
  return calls
    .filter((call) => call.tool.startsWith("POST ") && !call.held)
    .filter((call) => {
      if (!call.path || seen.has(call.path)) return false;
      seen.add(call.path);
      return true;
    })
    .filter((call) => /\.(md|json)$/.test(call.path))
    .filter((call) => !reviewed[`${call.time}|${call.path}`]);
}

/** Agent 待办子集：来自速记委派（有 memoId、无笔记路径），等价于 source === "agent"。 */
export function filterAgentTasks<T extends { path: string; memoId?: string }>(tasks: T[]): T[] {
  return tasks.filter((task) => Boolean(task.memoId) && !task.path);
}
