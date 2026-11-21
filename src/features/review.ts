import type { Store } from "../data/store";
import type { DayRecord } from "../types";
import { addDays, dateKey, eachDay, endOfWeek, startOfWeek } from "../utils/dates";
import { t, tf } from "../i18n";

const METRIC_ROWS: Array<[keyof DayRecord, string]> = [
  ["contribution", "贡献分"],
  ["wordsAdded", "新增词数"],
  ["edits", "编辑会话"],
  ["notesCreated", "新建笔记"],
  ["tasksCompleted", "完成任务"],
  ["focusMinutes", "专注分钟"],
];

/** 周复盘按「线索 — 行动 — 归档 — 详细数据」组织，先帮用户做决策。 */
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
  const agentTasks = memos.filter(
    (memo) => memo.tags.includes("to-agent") && !memo.converted
  );
  const pendingMemos = memos.filter(
    (memo) => !memo.converted && !memo.archived && !memo.tags.includes("to-agent")
  );
  const best = keys.reduce(
    (bestDay, day) =>
      store.getDay(day).contribution > store.getDay(bestDay).contribution ? day : bestDay,
    keys[0]
  );

  const lines: string[] = [];
  lines.push(`# ${tf("工作复盘 {start} ~ {end}", { start: dateKey(start), end: dateKey(end) })}`);
  lines.push("");

  // 1. 线索：先给可核对的事实
  lines.push(`## ${t("值得回看")}`);
  lines.push("");
  const clues: string[] = [];
  if (store.getDay(best).contribution > 0) {
    clues.push(tf("贡献最高的一天是 {day}（{score} 分）。", { day: best, score: store.getDay(best).contribution }));
  }
  if (pendingMemos.length > 0) clues.push(tf("还有 {n} 条速记尚未转化。", { n: pendingMemos.length }));
  if (agentTasks.length > 0) clues.push(tf("有 {n} 条带 #to-agent 的待办等待处理。", { n: agentTasks.length }));
  if (clues.length === 0) clues.push(t("本期记录较少，先把记录习惯保持住。"));
  for (const clue of clues) lines.push(`- ${clue}`);
  lines.push("");

  // 2. 成果与未完成事项
  lines.push(`## ${t("本期成果")}`);
  lines.push("");
  if (memos.length === 0) {
    lines.push(t("_本期没有速记。_"));
  } else {
    for (const memo of memos) {
      const tags = memo.tags.length ? ` ${memo.tags.map((tag) => `#${tag}`).join(" ")}` : "";
      lines.push(`- ${memo.date} ${memo.time} ${memo.text.replace(/\n/g, " ")}${tags}`);
    }
  }
  lines.push("");

  lines.push(`## ${t("未完成事项")}`);
  lines.push("");
  if (pendingMemos.length === 0 && agentTasks.length === 0) {
    lines.push(t("_没有未完成事项。_"));
  } else {
    for (const memo of pendingMemos) lines.push(`- [ ] ${tf("速记：{text}", { text: memo.text.replace(/\n/g, " ") })}`);
    for (const memo of agentTasks) lines.push(`- [ ] ${tf("Agent 任务：{text}", { text: memo.text.replace(/\n/g, " ") })}`);
  }
  lines.push("");

  // 3. 行动与归档
  lines.push(`## ${t("我的认识")}`);
  lines.push("");
  lines.push(t("_在这里写下本期复盘。_"));
  lines.push("");
  lines.push(`## ${t("下一步行动")}`);
  lines.push("");
  lines.push("- [ ] ");
  lines.push("");

  // 4. 详细数据与口径
  lines.push(`## ${t("本期总览")}`);
  lines.push("");
  lines.push(`| ${t("指标")} | ${t("本期")} | ${t("上期")} | ${t("变化")} |`);
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [key, label] of METRIC_ROWS) {
    const current = sum(keys, key);
    const previous = sum(prevKeys, key);
    const diff = current - previous;
    const pct = previous > 0 ? ` (${diff >= 0 ? "+" : ""}${Math.round((diff / previous) * 100)}%)` : "";
    lines.push(`| ${t(label)} | ${current} | ${previous} | ${diff >= 0 ? "+" : ""}${diff}${pct} |`);
  }
  lines.push(`| ${t("活跃天数")} | ${activeDays} | ${prevActive} | ${activeDays - prevActive >= 0 ? "+" : ""}${activeDays - prevActive} |`);
  lines.push("");

  lines.push(`## ${t("每日明细")}`);
  lines.push("");
  lines.push(
    `| ${t("日期")} | ${t("贡献")} | ${t("新增词")} | ${t("删除词")} | ${t("编辑")} | ${t("新笔记")} | ${t("任务")} | ${t("专注")} |`
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const day of keys) {
    const d = store.getDay(day);
    lines.push(
      `| ${day} | ${d.contribution} | ${d.wordsAdded} | ${d.wordsRemoved} | ${d.edits} | ${d.notesCreated} | ${d.tasksCompleted} | ${d.focusMinutes} |`
    );
  }
  lines.push("");

  const s = store.settings;
  const capNote = s.contributionDailyCap > 0 ? tf("，单日封顶 {cap}", { cap: s.contributionDailyCap }) : "";
  lines.push(
    `> ${tf("口径：贡献分 = 新建笔记×{n} + 编辑会话×{e} + 完成任务×{t} + 新增词数/{w} + 专注分钟/{f}{cap}；未记录日期不视作零。", {
      n: s.weightNotesCreated,
      e: s.weightEdits,
      t: s.weightTasks,
      w: s.wordsPerPoint,
      f: s.focusMinutesPerPoint,
      cap: capNote,
    })}`
  );
  return lines.join("\n");
}
