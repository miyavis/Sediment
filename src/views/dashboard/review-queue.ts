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

/** 待审的 Agent 变更：POST 调用、按路径去重、仅 md/json、排除已审查（kept/reverted）。 */
export function pendingReviewChanges(
  calls: ToolCallRecord[],
  reviewed: Record<string, unknown>
): ToolCallRecord[] {
  const seen = new Set<string>();
  return calls
    .filter((call) => call.tool.startsWith("POST "))
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
