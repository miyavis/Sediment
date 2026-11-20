/**
 * 知识地层剖面的月度聚合（Task 9）：纯函数，无 DOM / 插件状态，便于单测。
 * 输入 store.data 的原始持久化形状（按日 days + focusSessions 列表）与月份范围，
 * 输出每月 {human, agent, tasks, focus} 四类贡献总量，从旧到新排列。
 */
import type { DayRecord, FocusSessionRecord } from "../types";

export interface StrataMonth {
  /** 月份键 YYYY-MM */
  month: string;
  /** 人工写作词数（days.wordsAdded 求和） */
  human: number;
  /** Agent API 写作词数（days.aiWordsAdded 求和） */
  agent: number;
  /** 完成任务数（days.tasksCompleted 求和） */
  tasks: number;
  /** 专注分钟（focusSessions 中非休息会话的 minutes 求和，实测口径） */
  focus: number;
}

/** 月份范围，YYYY-MM，含两端。 */
export interface StrataRange {
  from: string;
  to: string;
}

/** 原始数据入口：字段可能缺失/脏（旧数据、手工编辑），聚合时逐项防御。 */
export interface StrataSource {
  days?: Record<string, Partial<DayRecord> | null> | null;
  focusSessions?: Array<Partial<FocusSessionRecord> | null> | null;
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 取正有限数值；缺失 / null / NaN / 负数一律按 0。 */
function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 列出 from→to（含两端）的每个月份键；非法格式或 from > to 返回 []。 */
export function listMonths(range: StrataRange): string[] {
  if (!MONTH_KEY.test(range.from) || !MONTH_KEY.test(range.to)) return [];
  let [year, month] = range.from.split("-").map(Number);
  const [toYear, toMonth] = range.to.split("-").map(Number);
  if (year > toYear || (year === toYear && month > toMonth)) return [];
  const out: string[] = [];
  while (year < toYear || (year === toYear && month <= toMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** 最近 n 个月（含当月）的范围，供剖面视图取默认窗口。 */
export function recentStrataRange(n: number, now: Date = new Date()): StrataRange {
  const count = Math.max(1, Math.floor(n) || 1);
  const toYear = now.getFullYear();
  const toMonth = now.getMonth() + 1;
  const absolute = toYear * 12 + (toMonth - 1) - (count - 1);
  const fromYear = Math.floor(absolute / 12);
  const fromMonth = (absolute % 12) + 1;
  return {
    from: `${fromYear}-${String(fromMonth).padStart(2, "0")}`,
    to: `${toYear}-${String(toMonth).padStart(2, "0")}`,
  };
}

/**
 * 按月聚合四类贡献。范围内每个月都产出一条（无数据为全 0），范围外数据忽略。
 * - days 键必须是规范 YYYY-MM-DD（store 的唯一口径），非法键跳过；
 * - focusSessions 只计专注会话：mode 为 short/long 的休息排除，
 *   缺失 mode 的旧记录按专注计；date 缺失或非法跳过。
 */
export function aggregateStrata(source: StrataSource, range: StrataRange): StrataMonth[] {
  const months = listMonths(range);
  const buckets = new Map<string, StrataMonth>(
    months.map((month) => [month, { month, human: 0, agent: 0, tasks: 0, focus: 0 }])
  );
  for (const [key, day] of Object.entries(source.days ?? {})) {
    const bucket = buckets.get(key.slice(0, 7));
    if (!bucket || !day) continue;
    bucket.human += positive(day.wordsAdded);
    bucket.agent += positive(day.aiWordsAdded);
    bucket.tasks += positive(day.tasksCompleted);
  }
  for (const session of source.focusSessions ?? []) {
    if (!session || typeof session.date !== "string") continue;
    if (session.mode === "short" || session.mode === "long") continue;
    const bucket = buckets.get(session.date.slice(0, 7));
    if (!bucket) continue;
    bucket.focus += positive(session.minutes);
  }
  return months.map((month) => buckets.get(month)!);
}