/** Agent 调用统计：按客户端累计，并单独保留 24 小时（小时桶）与 7 天（日期桶）口径。
 *  调用流水 toolCalls 有 500 条上限，长窗口不能从流水反推，因此聚合值单独持久化。 */

import type { AgentUsageMap, AgentUsageStat, ToolCallRecord } from "../types";
import { addDays, dateKey, lastNDays } from "../utils/dates";

/** 「活跃」徽章口径：最近 5 分钟内有调用。 */
export const AGENT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
/** 小时桶保留 25 个（当前小时 + 之前 24 个），日期桶保留 8 天。 */
const KEEP_HOURS = 25;
const KEEP_DAYS = 8;

function emptyUsage(): AgentUsageStat {
  return { total: 0, lastAt: "", lastTool: "", hours: {}, days: {} };
}

function hourKey(ms: number): string {
  return String(Math.floor(ms / HOUR_MS));
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (count) => typeof count === "number" && Number.isFinite(count) && count >= 0
  );
}

/** 校验持久化聚合值；形状不可用返回 null（调用方回退为按流水重建）。 */
export function sanitizeAgentUsage(value: unknown): AgentUsageMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage: AgentUsageMap = {};
  for (const [agent, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const stat = raw as Partial<AgentUsageStat>;
    if (typeof stat.total !== "number" || !Number.isFinite(stat.total) || stat.total < 0) continue;
    usage[agent] = {
      total: Math.floor(stat.total),
      lastAt: typeof stat.lastAt === "string" ? stat.lastAt : "",
      lastTool: typeof stat.lastTool === "string" ? stat.lastTool : "",
      hours: isCountMap(stat.hours) ? { ...stat.hours } : {},
      days: isCountMap(stat.days) ? { ...stat.days } : {},
    };
  }
  return usage;
}

/** 旧版没有聚合字段时，用现有流水（最多 500 条）重建；更早的历史无法补回。 */
export function rebuildAgentUsage(
  calls: readonly ToolCallRecord[],
  nowMs = Date.now()
): AgentUsageMap {
  const usage: AgentUsageMap = {};
  for (const call of [...calls].reverse()) {
    recordAgentUsage(usage, call.agent, call.time, call.tool, nowMs);
  }
  return usage;
}

/** 记录一次调用：累计数 + 最近时间/工具 + 小时桶 + 日期桶，并顺带清理过期桶。 */
export function recordAgentUsage(
  usage: AgentUsageMap,
  agent: string,
  time: string,
  tool: string,
  nowMs = Date.now()
): void {
  const stat = usage[agent] ?? (usage[agent] = emptyUsage());
  const parsed = Date.parse(time);
  const at = Number.isFinite(parsed) ? parsed : nowMs;
  stat.total += 1;
  const previous = Date.parse(stat.lastAt);
  if (!Number.isFinite(previous) || at >= previous) {
    stat.lastAt = new Date(at).toISOString();
    stat.lastTool = tool;
  }
  const hours = hourKey(at);
  stat.hours[hours] = (stat.hours[hours] ?? 0) + 1;
  const day = dateKey(new Date(at));
  stat.days[day] = (stat.days[day] ?? 0) + 1;
  pruneAgentUsage(stat, nowMs);
}

function pruneAgentUsage(stat: AgentUsageStat, nowMs: number): void {
  const minHour = Number(hourKey(nowMs)) - (KEEP_HOURS - 1);
  for (const key of Object.keys(stat.hours)) {
    const hour = Number(key);
    if (!Number.isFinite(hour) || hour < minHour) delete stat.hours[key];
  }
  const keepFrom = dateKey(addDays(new Date(nowMs), -(KEEP_DAYS - 1)));
  for (const key of Object.keys(stat.days)) {
    if (key < keepFrom) delete stat.days[key];
  }
}

/** 近 24 小时：当前小时桶往前数 24 个（小时边界近似）。 */
export function recentHourCount(stat: AgentUsageStat, nowMs = Date.now()): number {
  const current = Number(hourKey(nowMs));
  let total = 0;
  for (let i = 0; i < 24; i += 1) total += stat.hours[String(current - i)] ?? 0;
  return total;
}

/** 近 7 天：今天及之前 6 个本地日期。 */
export function recentDayCount(stat: AgentUsageStat, nowMs = Date.now()): number {
  return lastNDays(7, new Date(nowMs)).reduce((sum, day) => sum + (stat.days[day] ?? 0), 0);
}

export function isAgentActive(stat: AgentUsageStat, nowMs = Date.now()): boolean {
  const last = Date.parse(stat.lastAt);
  return Number.isFinite(last) && last <= nowMs && nowMs - last <= AGENT_ACTIVE_WINDOW_MS;
}

export interface AgentUsageSummary {
  agent: string;
  total: number;
  last24h: number;
  last7d: number;
  lastAt: string;
  lastTool: string;
  active: boolean;
}

/** 看板用摘要：按最近调用时间倒序，时间相同时按累计次数。 */
export function summarizeAgentUsage(
  usage: AgentUsageMap,
  nowMs = Date.now()
): AgentUsageSummary[] {
  return Object.entries(usage)
    .map(([agent, stat]) => ({
      agent,
      total: stat.total,
      last24h: recentHourCount(stat, nowMs),
      last7d: recentDayCount(stat, nowMs),
      lastAt: stat.lastAt,
      lastTool: stat.lastTool,
      active: isAgentActive(stat, nowMs),
    }))
    .sort((a, b) => {
      const left = Date.parse(a.lastAt);
      const right = Date.parse(b.lastAt);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
      return b.total - a.total || a.agent.localeCompare(b.agent);
    });
}

export function totalAgentCalls(usage: AgentUsageMap): number {
  return Object.values(usage).reduce((sum, stat) => sum + stat.total, 0);
}
