/** 看板共享常量与类型（避免 section 模块反向 import 视图造成运行时循环依赖）。 */

export type TabKey = "today" | "insights" | "agent";
export type RangeKey = "7d" | "30d" | "90d" | "ytd" | "1y";

export const TABS: Array<[TabKey, string]> = [
  ["today", "今日"],
  ["insights", "知识地层"],
  ["agent", "智能体工坊"],
];

export const RANGE_OPTIONS: Array<[RangeKey, string]> = [
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["90d", "近 90 天"],
  ["ytd", "今年"],
  ["1y", "近一年"],
];

export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function startOfWeekFor(date: Date, weekStart: 0 | 1): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const diff = (copy.getDay() - weekStart + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}
