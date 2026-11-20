/** 今日脉冲页签的渲染逻辑。所有共享状态/方法通过 view 访问。
 *  工作日志与连接状态卡自智能体工坊迁入（D2=B）；番茄唯一入口是今日卡内 toggle。 */
import { exportTodayReport } from "../../../features/embed";
import { dateKey, isSameLocalDay, localHHmm } from "../../../utils/dates";
import { goalRing as goalRingSvg } from "../../../utils/charts";
import { t, tf } from "../../../i18n";
import { renderAgentStatus, renderWorkLogs } from "./agent";
import type { DashboardView } from "../../dashboard-view";

export function renderToday(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  const actions = body.createDiv({ cls: "sd-today-actions" });
  const memoAction = actions.createEl("button", {
    cls: "sd-today-action is-primary",
    text: t("记一条速记"),
  });
  memoAction.onclick = () => {
    const area = root.querySelector(".sd-quick-memo textarea") as HTMLTextAreaElement | null;
    if (!area) return;
    view.scrollToElement(area, "center");
    area.focus({ preventScroll: true });
  };
  const taskAction = actions.createEl("button", {
    cls: "sd-today-action",
    text: t("查看今日任务"),
  });
  taskAction.onclick = () => {
    const tasks = root.querySelector(".sd-tasks") as HTMLElement | null;
    if (tasks) view.scrollToElement(tasks);
  };
  const bento = body.createDiv({ cls: "sd-bento" });
  renderTodayCard(view, bento);
  renderQuickMemo(view, bento);
  view.renderTasksCard(bento);
  renderTodayAgent(view, bento);
  bento.querySelector(".sd-today")?.addClass("sd-bento-today");
  bento.querySelector(".sd-quick-memo")?.addClass("sd-bento-memo");
  bento.querySelector(".sd-tasks")?.addClass("sd-bento-tasks");
  bento.querySelector(".sd-agent-feed")?.addClass("sd-bento-agent");
  // 工作日志保持可达（D2=B 迁移意图，compact 下不隐藏）；连接状态卡沿用旧隐藏规则。
  renderWorkLogs(view, body.createDiv({ cls: "sd-secondary" }));
  const secondary = body.createDiv({ cls: "sd-secondary sd-agent-secondary" });
  renderAgentStatus(view, secondary);
  renderHints(view, body);
}

export function renderHints(view: DashboardView, root: HTMLElement): void {
  if (view.plugin.store.settings.hintsDismissed) return;
  const card = root.createDiv({ cls: "sd-card sd-hints" });
  card.createDiv({ cls: "sd-card-title", text: t("首次使用提示") });
  const list = card.createDiv({ cls: "sd-hint-list" });
  const hints = [
    t("贡献分是加权统计，不代表知识质量；口径可在周复盘底部查看。"),
    t("Agent 生成的笔记会标为草稿，在「智能体工坊」里审核后再采纳。"),
    t("热力图格子可悬停查看当天明细，也可用方向键移动。"),
  ];
  for (const hint of hints) list.createDiv({ cls: "sd-hint-item", text: hint });
  card.createEl("button", { text: t("知道了，不再显示") }).onclick = () => {
    view.plugin.store.settings.hintsDismissed = true;
    void view.plugin.saveSettings();
    view.render();
  };
}

export function renderTodayCard(view: DashboardView, root: HTMLElement): void {
  const today = dateKey(new Date());
  const day = view.plugin.store.getDay(today);
  const streak = view.currentStreak();
  const goal = view.plugin.store.settings.dailyWordGoal || 1000;
  const card = root.createDiv({ cls: "sd-card sd-today" });
  const head = card.createDiv({ cls: "sd-today-head" });
  head.createDiv({ cls: "sd-today-title", text: t("今天") });
  head.createDiv({ cls: "sd-pill", text: day.contribution > 0 ? tf("{n} 分", { n: day.contribution }) : t("还没开始") });
  const goalRing = head.createDiv({ cls: "sd-goal-ring" });
  goalRing.innerHTML = goalRingSvg(day.wordsAdded, goal);
  head.createEl("button", { cls: "sd-share-today", text: t("战报图片") }).onclick = () => {
    exportTodayReport({
      date: today,
      contribution: day.contribution,
      words: day.wordsAdded,
      streak,
      longest: view.longestStreak(),
      memos: view.plugin.store.data.memos.filter((memo) => memo.date === today).length,
      agentCalls: view.plugin.store.data.toolCalls.filter((call) => isSameLocalDay(call.time, today)).length,
    });
  };
  const row = card.createDiv({ cls: "sd-today-row" });
  row.createSpan({ text: tf("写作 {words} / {goal} 字", { words: day.wordsAdded, goal: goal.toLocaleString() }) });
  row.createSpan({ text: tf("连续 {streak} 天 · 最长 {longest} 天", { streak, longest: view.longestStreak() }) });
  const pomoButton = row.createEl("button", { cls: "sd-pomodoro-button" });
  pomoButton.onclick = () => view.plugin.pomodoro.toggle();
  view.updatePomodoroButton();
  const skip = row.createEl("button", { cls: "sd-pomodoro-skip", text: t("跳过") });
  skip.onclick = () => view.plugin.pomodoro.skip();
  const progress = card.createDiv({ cls: "sd-progress" });
  progress.createDiv({ cls: "sd-progress-fill" }).style.width = `${Math.min(100, (day.wordsAdded / goal) * 100)}%`;
}

export function renderQuickMemo(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-quick-memo" });
  card.createDiv({ cls: "sd-card-title", text: t("快速速记") });
  const area = card.createEl("textarea", { cls: "sd-memo-input" });
  area.placeholder = t("想到什么，随手记下…");
  area.rows = 2;
  const draftKey = "sediment.quick-memo.draft";
  try {
    area.value = localStorage.getItem(draftKey) ?? "";
  } catch {}
  const status = card.createDiv({ cls: "sd-save-status", text: area.value ? t("草稿已恢复") : t("未保存") });
  area.oninput = () => {
    try {
      localStorage.setItem(draftKey, area.value);
      status.setText(area.value ? t("草稿已保存") : t("未保存"));
    } catch {
      status.setText(t("草稿保存失败"));
    }
  };
  const submit = card.createEl("button", { cls: "mod-cta", text: t("记一条") });
  submit.onclick = () => {
    const text = area.value.trim();
    if (!text) return;
    submit.disabled = true;
    status.setText(t("保存中…"));
    void view.plugin.memos.add(text).then((memo) => {
      if (memo) {
        area.value = "";
        try { localStorage.removeItem(draftKey); } catch {}
        status.setText(t("已保存"));
        view.render();
      } else {
        submit.disabled = false;
        status.setText(t("保存失败，请重试"));
      }
    }).catch(() => {
      submit.disabled = false;
      status.setText(t("保存失败，请重试"));
    });
  };
}

export function renderTodayAgent(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-agent-feed" });
  card.createDiv({ cls: "sd-card-title", text: t("今日 Agent 动态") });
  const today = dateKey(new Date());
  const calls = view.plugin.store.data.toolCalls.filter((call) => isSameLocalDay(call.time, today));
  const logs = view.plugin.store.data.workLogs.filter((log) => log.date === today);
  if (calls.length === 0 && logs.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("今天还没有智能体活动。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const call of calls.slice(0, 8)) {
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({ text: `${localHHmm(call.time)} · ${call.agent || "unknown"}` });
    const tool = call.tool.replace(/^(GET|POST) /, "");
    const target = call.path ? call.path.split("/").pop() : "";
    row.createEl("strong", { text: target ? `${tool} · ${target}` : tool, attr: { title: call.path || tool } });
  }
  for (const log of logs) {
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({ text: `${log.time} · ${log.agent}` });
    row.createEl("strong", { text: log.task });
  }
}
