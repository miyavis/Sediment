import type { PendingWriteRecord } from "../types";

/**
 * 轻量对账：待审写入挂起后，目标文件可能被删除/移动（含绕过 MCP 的直写）。
 * 规则：before 非空（挂起时目标已存在）而目标现在不存在 → 标记 stale。
 * 新建类（before 为空）不标记：目标本来就不存在，采纳时自然新建。
 * 纯函数，不触库；启动对账与事件标记共用同一语义。
 */
export function reconcilePendingWrites(
  records: PendingWriteRecord[],
  exists: (path: string) => boolean
): number {
  let marked = 0;
  for (const record of records) {
    if (record.stale) continue;
    if (record.before !== "" && !exists(record.path)) {
      record.stale = true;
      marked += 1;
    }
  }
  return marked;
}

/** 删除/重命名事件即时标记：路径命中即 stale（重命名后原路径失效，不迁移）。 */
export function markStaleByPaths(records: PendingWriteRecord[], paths: string[]): number {
  const hit = new Set(paths);
  let marked = 0;
  for (const record of records) {
    if (record.stale || !hit.has(record.path)) continue;
    record.stale = true;
    marked += 1;
  }
  return marked;
}
