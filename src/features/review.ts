import type { Store } from "../data/store";
import type { DayRecord } from "../types";
import { addDays, dateKey, eachDay, endOfWeek, startOfWeek } from "../utils/dates";

const METRIC_ROWS: Array<[keyof DayRecord, string]> = [
  ["contribution", "贡献分"],
  ["wordsAdded", "新增词数"],
  ["edits", "编辑会话"],
  ["notesCreated", "新建笔记"],
  ["tasksCompleted", "完成任务"],
  ["focusMinutes", "专注分钟"],
];

/** 根据某个锚点日期，生成它所在自然周的 Markdown 复盘报告。 */
export function buildWeeklyReview(store: Store, anchor: Date): string {
  const weekStart = store.settings.weekStart;
  const start = startOfWeek(anchor, weekStart);
  const end = endOfWeek(anchor, weekStart);
  const keys = eachDay(start, end);
  const prevKeys = eachDay(addDays(start, -7), addDays(end, -7));

  const sum = (days: string[], key: keyof DayRecord): number =>
    days.reduce((total, day) => total + (Number(store.getDay(day)[key]) || 0), 0);
  const activeDays = keys.filter((day) => store.getDay(day).contribution > 0).length;
  const prevActive = prevKeys.filter((day) => store.getDay(day).contribution > 0).length;
  const memos = store.data.memos.filter(
    (memo) => memo.date >= keys[0] && memo.date <= keys[keys.length - 1]
  );

  const lines: string[] = [];
  lines.push(`# 工作复盘 ${dateKey(start)} ~ ${dateKey(end)}`);
  lines.push("");
  lines.push(
    `> 生成于 ${dateKey(new Date())}。口径：贡献分 = 新建笔记×2 + 编辑会话 + 完成任务 + 新增词数/100 + 专注分钟/25；未记录日期不视作零。`
  );
  lines.push("");

  lines.push("## 本期总览");
  lines.push("");
  lines.push("| 指标 | 本期 | 上期 | 变化 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [key, label] of METRIC_ROWS) {
    const current = sum(keys, key);
    const previous = sum(prevKeys, key);
    const diff = current - previous;
    const pct = previous > 0 ? ` (${diff >= 0 ? "+" : ""}${Math.round((diff / previous) * 100)}%)` : "";
    lines.push(`| ${label} | ${current} | ${previous} | ${diff >= 0 ? "+" : ""}${diff}${pct} |`);
  }
  lines.push(`| 活跃天数 | ${activeDays} | ${prevActive} | ${activeDays - prevActive >= 0 ? "+" : ""}${activeDays - prevActive} |`);
  lines.push("");

  lines.push("## 每日明细");
  lines.push("");
  lines.push("| 日期 | 贡献 | 新增词 | 删除词 | 编辑 | 新笔记 | 任务 | 专注 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const day of keys) {
    const d = store.getDay(day);
    lines.push(
      `| ${day} | ${d.contribution} | ${d.wordsAdded} | ${d.wordsRemoved} | ${d.edits} | ${d.notesCreated} | ${d.tasksCompleted} | ${d.focusMinutes} |`
    );
  }
  lines.push("");

  lines.push("## 本期速记");
  lines.push("");
  if (memos.length === 0) {
    lines.push("_本期没有速记。_");
  } else {
    for (const memo of memos) {
      const tags = memo.tags.length ? ` ${memo.tags.map((tag) => `#${tag}`).join(" ")}` : "";
      lines.push(`- ${memo.date} ${memo.time} ${memo.text.replace(/\n/g, " ")}${tags}`);
    }
  }
  lines.push("");

  lines.push("## 值得回看");
  lines.push("");
  const best = keys.reduce((bestDay, day) =>
    store.getDay(day).contribution > store.getDay(bestDay).contribution ? day : bestDay, keys[0]);
  const clues: string[] = [];
  if (store.getDay(best).contribution > 0) {
    clues.push(`贡献最高的一天是 ${best}（${store.getDay(best).contribution} 分）。`);
  }
  const pending = store.data.memos.filter((memo) => !memo.converted).length;
  if (pending > 0) clues.push(`还有 ${pending} 条速记尚未转化。`);
  if (clues.length === 0) clues.push("本期记录较少，先把记录习惯保持住。");
  for (const clue of clues) lines.push(`- ${clue}`);
  lines.push("");

  lines.push("## 我的认识");
  lines.push("");
  lines.push("_在这里写下本期复盘。_");
  lines.push("");
  lines.push("## 下一步行动");
  lines.push("");
  lines.push("- [ ] ");
  lines.push("");

  return lines.join("\n");
}
