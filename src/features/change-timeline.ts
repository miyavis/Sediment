/** 变更时间线：把调用流水、待审写入、审批决定、快照合并成一条可检索的审计事件流。
 *  纯函数，不依赖 Obsidian / DOM；UI 与 MCP 工具共用同一口径。 */
import type { PendingWriteRecord, SedimentData, ReviewChangeValue, ReviewDecision, ToolCallRecord, WriteDecisionRecord } from "../types";

export type TimelineKind = "call" | "pending" | "decision" | "snapshot";

export interface ChangeTimelineEvent {
  /** 稳定 key，供 UI 列表复用 */
  id: string;
  time: string;
  kind: TimelineKind;
  agent: string;
  tool: string;
  path: string;
  /** 人类可读结论 */
  title: string;
  /** 挂起时冻结的 before 哈希 */
  hash?: string;
  decision?: ReviewDecision;
  snapshotId?: string;
  pendingId?: string;
  status?: "held" | "stale" | "approved" | "rejected";
  /** 审批原因（user_rejected / stale 等），供 Agent 查询驳回结果（4.1） */
  reason?: string;
}

export interface TimelineOptions {
  limit?: number;
  agent?: string;
  path?: string;
  /** 是否包含 GET 等只读调用；默认 false，时间线只展示写入审计链 */
  includeReads?: boolean;
  /** 从第几条开始（用于分页） */
  offset?: number;
}

/** 兼容旧数据：reviewedChanges 的值可能是字符串或带时间戳的对象。 */
export function reviewDecisionOf(value: ReviewChangeValue | undefined): ReviewDecision | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.decision;
}

function reviewTimeOf(key: string, value: ReviewChangeValue): string {
  if (typeof value !== "string" && value.time) return value.time;
  // 旧格式只有 `time|path` 的 key，用调用时间近似。
  return key.split("|")[0] ?? "";
}

/** 按 pendingId 找关联调用，供 UI 把「调用→挂起」串起来。 */
export function findCallByPendingId(calls: ToolCallRecord[], pendingId: string): ToolCallRecord | undefined {
  return calls.find((call) => call.pendingId === pendingId);
}

/** 构造时间线，按时间倒序。 */
export function buildChangeTimeline(data: SedimentData, options: TimelineOptions = {}): ChangeTimelineEvent[] {
  const events: ChangeTimelineEvent[] = [];
  const calls = data.toolCalls ?? [];
  const pending = data.pendingWrites ?? [];
  const snapshots = data.snapshots ?? [];
  const reviewed = data.reviewedChanges ?? {};
  const writeDecisions = data.writeDecisions ?? [];

  for (const call of calls) {
    if (!options.includeReads && call.tool.startsWith("GET ")) continue;
    events.push({
      id: `call:${call.time}|${call.path}|${call.tool}`,
      time: call.time,
      kind: "call",
      agent: call.agent || "agent",
      tool: call.tool,
      path: call.path,
      title: call.tool,
      pendingId: call.pendingId,
      status: call.held ? "held" : undefined,
    });
  }

  for (const item of pending) {
    events.push(pendingEvent(item));
  }

  for (const [key, value] of Object.entries(reviewed)) {
    const sep = key.indexOf("|");
    const callTime = sep >= 0 ? key.slice(0, sep) : key;
    const path = sep >= 0 ? key.slice(sep + 1) : "";
    const decision = reviewDecisionOf(value);
    if (!decision) continue;
    const snapshot = snapshots.find((snap) => snap.path === path && snap.time >= callTime);
    events.push({
      id: `decision:${key}`,
      time: reviewTimeOf(key, value),
      kind: "decision",
      agent: snapshot?.agent || "user",
      tool: snapshot?.tool || "review",
      path,
      title: decision === "kept" ? "保留当前版本" : "采用备份并撤销",
      decision,
      snapshotId: snapshot?.id,
    });
  }

  for (const decision of writeDecisions) {
    events.push(writeDecisionEvent(decision));
  }

  for (const snap of snapshots) {
    events.push({
      id: `snapshot:${snap.id}`,
      time: snap.time,
      kind: "snapshot",
      agent: snap.agent,
      tool: snap.tool,
      path: snap.path,
      title: "写入前快照",
      snapshotId: snap.id,
    });
  }

  let result = events.filter((event) => {
    if (options.agent && event.agent !== options.agent) return false;
    if (options.path && !event.path.includes(options.path)) return false;
    return true;
  });
  result = result.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const start = Math.max(0, options.offset ?? 0);
  return options.limit && options.limit > 0 ? result.slice(start, start + options.limit) : result;
}

function writeDecisionEvent(decision: WriteDecisionRecord): ChangeTimelineEvent {
  const titles: Record<WriteDecisionRecord["decision"], string> = {
    approved: "已采纳待审写入",
    rejected: "已驳回待审写入",
    stale: "待审写入已失效",
  };
  return {
    id: decision.id,
    time: decision.time,
    kind: "decision",
    agent: decision.agent || "user",
    tool: decision.tool,
    path: decision.path,
    title: titles[decision.decision],
    decision: decision.decision === "rejected" ? "reverted" : decision.decision === "approved" ? "kept" : undefined,
    pendingId: decision.pendingId,
    status: decision.decision,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}

function pendingEvent(item: PendingWriteRecord): ChangeTimelineEvent {
  return {
    id: `pending:${item.id}`,
    time: item.time,
    kind: "pending",
    agent: item.agent,
    tool: item.tool,
    path: item.path,
    title: item.stale ? "待审写入（已失效）" : "待审写入",
    hash: item.beforeHash,
    pendingId: item.id,
    status: item.stale ? "stale" : "held",
  };
}
