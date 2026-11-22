/** 今日脉冲页签的渲染逻辑。所有共享状态/方法通过 view 访问。
 *  工作日志与连接状态卡自智能体工坊迁入（D2=B）；番茄唯一入口是今日卡内 toggle。 */
import { exportTodayReport } from "../../../features/embed";
import { dateKey, isSameLocalDay, localHHmm } from "../../../utils/dates";
import { goalRing as goalRingSvg } from "../../../utils/charts";
import { t, tf } from "../../../i18n";
import { appendSvg } from "../../../utils/dom";
import { renderWorkLogs } from "./agent";
import { pendingReviewChanges } from "../review-queue";
import type { DashboardView } from "../../dashboard-view";

export function renderToday(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  renderAuditSummary(view, body);
  // 空库（刚安装/数据重置）时不渲染一片 0 的 bento，改为引导卡。
  if (isEmptyVault(view)) {
    renderOnboarding(view, body);
    return;
  }
  const actions = body.createDiv({ cls: "sd-today-actions" });
  const memoAction = actions.createEl("button", {
    cls: "sd-today-action is-primary",
    text: `↓ ${t("去记速记")}`,
    attr: { title: t("滚动到下方速记输入框") },
  });
  memoAction.onclick = () => {
    const area = root.querySelector<HTMLTextAreaElement>(".sd-quick-memo textarea");
    if (!area) return;
    view.scrollToElement(area, "center");
    area.focus({ preventScroll: true });
  };
  const taskAction = actions.createEl("button", {
    cls: "sd-today-action",
    text: `↓ ${t("查看今日任务")}`,
    attr: { title: t("滚动到下方待办卡片") },
  });
  taskAction.onclick = () => {
    const tasks = root.querySelector<HTMLElement>(".sd-tasks");
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
  // 工作日志保持可达；连接状态卡已归入智能体工坊页。
  renderWorkLogs(view, body.createDiv({ cls: "sd-secondary" }));
  renderHints(view, body);
}

function isEmptyVault(view: DashboardView): boolean {
  const data = view.plugin.store.data;
  return Object.keys(data.days ?? {}).length === 0 &&
    (data.memos ?? []).length === 0 &&
    (data.toolCalls ?? []).length === 0;
}

/** 空库引导：告诉用户下一步做什么，而不是展示一片 0。 */
function renderOnboarding(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-onboarding-card" });
  card.createDiv({ cls: "sd-card-title", text: t("开始使用 Sediment") });
  card.createDiv({
    cls: "sd-card-sub",
    text: t("这是一个本地优先的知识库插件。先确认工作模式与目录，再让 Agent 接入——所有写入都可审批、可回滚、可追溯。"),
  });
  const steps = card.createDiv({ cls: "sd-onboarding-steps" });
  const step = (n: number, text: string, action?: () => void, label?: string): void => {
    const row = steps.createDiv({ cls: "sd-onboarding-step" });
    row.createSpan({ cls: "sd-onboarding-num", text: String(n) });
    row.createSpan({ text });
    if (action && label) row.createEl("button", { text: label }).onclick = action;
  };
  step(1, t("在 Obsidian 设置 → 第三方插件 → Sediment 中确认日记目录与「确认后写入」模式"));
  step(2, t("把 examples/AGENTS.md 复制到库根目录，让 Agent 走 MCP 写入"));
  step(3, t("让 Agent 写入一次笔记，在智能体工坊审批——变更会出现在审计时间线"), () => {
    view.tab = "agent";
    view.render();
  }, t("查看工坊"));
}

/** 审计摘要：把差异化信号（待审/变更/快照/最近采纳）前置到今日页首屏。 */
function renderAuditSummary(view: DashboardView, root: HTMLElement): void {
  const data = view.plugin.store.data;
  const pending = data.pendingWrites?.length ?? 0;
  const changes = pendingReviewChanges(data.toolCalls, data.reviewedChanges).length;
  const snapshots = data.snapshots?.length ?? 0;
  const lastKept = Object.entries(data.reviewedChanges ?? {})
    .filter(([, value]) => typeof value === "string" ? value === "kept" : value.decision === "kept")
    .map(([key, value]) => ({
      time: typeof value === "string" ? key.split("|")[0] ?? "" : (value as { time?: string }).time ?? "",
      path: key.split("|").slice(1).join("|"),
    }))
    .sort((a, b) => (a.time < b.time ? 1 : -1))[0];
  const summary = root.createDiv({ cls: "sd-audit-strip sd-today-audit" });
  summary.createSpan({ cls: "sd-audit-strip-title", text: t("Agent 写入审计") });
  summary.createSpan({
    text: `${t("待审")} ${pending} · ${t("变更审查")} ${changes} · ${t("快照")} ${snapshots}` +
      (lastKept?.time ? ` · ${tf("最近采纳 {time}", { time: localHHmm(lastKept.time) })}` : ""),
    attr: { title: lastKept?.path || "" },
  });
  const open = summary.createEl("button", { cls: "sd-audit-strip-open", text: t("查看审计") });
  open.onclick = () => {
    view.tab = "agent";
    view.render();
  };
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
  appendSvg(goalRing, goalRingSvg(day.wordsAdded, goal));
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
  // 专注计时器已挪到「知识地层」页（作为人类专注时长的数据源），今日页不再占用主操作行。
  const progress = card.createDiv({ cls: "sd-progress" });
  progress.createDiv({ cls: "sd-progress-fill" }).setCssStyles({
    width: `${Math.min(100, (day.wordsAdded / goal) * 100)}%`,
  });
}

export function renderQuickMemo(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-quick-memo" });
  card.createDiv({ cls: "sd-card-title", text: t("快速速记") });
  const area = card.createEl("textarea", { cls: "sd-memo-input" });
  area.placeholder = t("想到什么，随手记下…");
  area.rows = 2;
  const draftKey = "sediment.quick-memo.draft";
  const savedDraft = view.plugin.app.loadLocalStorage(draftKey) as unknown;
  area.value = typeof savedDraft === "string" ? savedDraft : "";
  const status = card.createDiv({ cls: "sd-save-status", text: area.value ? t("草稿已恢复") : t("未保存") });
  area.oninput = () => {
    view.plugin.app.saveLocalStorage(draftKey, area.value || null);
    status.setText(area.value ? t("草稿已保存") : t("未保存"));
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
        view.plugin.app.saveLocalStorage(draftKey, null);
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
