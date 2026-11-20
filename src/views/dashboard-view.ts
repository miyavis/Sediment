import { ItemView, MarkdownRenderer, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { ChangelogModal } from "../ui/changelog-modal";
import { DiffModal } from "../ui/diff-modal";
import { PosterModal } from "../ui/poster-modal";
import { listBackups, readBackup, restoreBackup } from "../features/audit";
import { buildWeeklyReview } from "../features/review";
import { exportTodayReport } from "../features/embed";
import { METRICS, type MetricKey } from "../types";
import { addDays, dateKey, lastNDays, parseKey } from "../utils/dates";
import { t, tf } from "../i18n";

export const DASHBOARD_VIEW_TYPE = "sediment-dashboard";

type TabKey = "today" | "insights" | "agent";
type RangeKey = "7d" | "30d" | "90d" | "ytd" | "1y";
type ChartRef = { value: number; label: string; color?: string };

const TABS: Array<[TabKey, string]> = [
  ["today", "今日脉冲"],
  ["insights", "知识地层"],
  ["agent", "智能体工坊"],
];

const RANGE_OPTIONS: Array<[RangeKey, string]> = [
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["90d", "近 90 天"],
  ["ytd", "今年"],
  ["1y", "近一年"],
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 三段式主看板：今日脉冲 / 知识地层 / 智能体工坊。 */
export class DashboardView extends ItemView {
  private tab: TabKey = "today";
  private metric: MetricKey = "contribution";
  private range: RangeKey = "1y";
  private trendTab: "writing" | "changes" | "time" | "source" = "writing";
  private rhythmTab: "matrix" | "hours" = "matrix";
  private yearlyTab: "wheel" | "fingerprint" | "moon" = "wheel";
  private rhythmActiveOnly = true;
  private foldersExpanded = false;
  private selected: string | null = null;
  private posterMonth = new Date().getMonth();
  private bannerEl: HTMLElement | null = null;
  private heatTooltip: HTMLElement | null = null;
  private unsubscribePomodoro: (() => void) | null = null;
  private lastRenderedTab: TabKey | null = null;
  private pendingFocusDate: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: SedimentPlugin) {
    super(leaf);
    this.metric = plugin.store.settings.heatmapMetric;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("Sediment 知识脉冲");
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    this.render();
    this.registerInterval(window.setInterval(() => this.updateBanner(), 60_000));
    this.unsubscribePomodoro = this.plugin.pomodoro.subscribe(() => this.updatePomodoroButton());
  }

  async onClose(): Promise<void> {
    this.unsubscribePomodoro?.();
    this.hideHeatTooltip();
  }

  render(): void {
    const root = this.contentEl;
    const scroller = this.scrollParent(root);
    const sameTab = this.lastRenderedTab === this.tab;
    const scrollTop = sameTab && scroller ? scroller.scrollTop : 0;
    root.empty();
    root.addClass("sd-dashboard");
    root.setAttribute("data-density", this.plugin.store.settings.layoutDensity);
    root.toggleClass("is-reduced-motion", this.plugin.store.settings.reducedMotion);
    root.setAttribute("data-tab", this.tab);
    this.renderHeader(root);

    if (this.tab === "today") this.renderToday(root);
    else if (this.tab === "insights") this.renderInsights(root);
    else this.renderAgentHub(root);
    this.lastRenderedTab = this.tab;

    // 同页签刷新保留滚动位置，避免软刷新把用户弹回顶部。
    if (scroller) scroller.scrollTop = scrollTop;
    if (this.pendingFocusDate) {
      const target = root.querySelector(
        `.kp-cell[data-date="${this.pendingFocusDate}"]`
      ) as HTMLElement | null;
      this.pendingFocusDate = null;
      target?.focus();
    }
  }

  /** 找到看板真正滚动的祖先容器（Obsidian 的 .view-content）。 */
  private scrollParent(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return null;
  }

  private value(key: string): number {
    return Number(this.plugin.store.getDay(key)[this.metric]) || 0;
  }

  private activeDaysCount(): number {
    return Object.values(this.plugin.store.data.days).filter((day) => day.contribution > 0).length;
  }

  /** 数据不足 14 天时，折线/柱状图默认聚焦最近 14 天，避免最右侧一根细线。 */
  private chartKeys(): string[] {
    const keys = this.rangeKeys();
    return this.activeDaysCount() < 14 ? keys.slice(-14) : keys;
  }

  private rangeKeys(): string[] {
    const today = new Date();
    if (this.range === "7d") return lastNDays(7, today);
    if (this.range === "30d") return lastNDays(30, today);
    if (this.range === "90d") return lastNDays(90, today);
    if (this.range === "ytd") {
      const keys: string[] = [];
      for (let day = new Date(today.getFullYear(), 0, 1); day <= today; day = addDays(day, 1)) {
        keys.push(dateKey(day));
      }
      return keys;
    }
    return lastNDays(365, today);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "sd-header" });
    const banner = header.createDiv({ cls: "sd-banner" });
    banner.innerHTML = this.bannerSvg();
    this.bannerEl = banner;

    const bar = header.createDiv({ cls: "sd-navbar" });
    bar.createDiv({ cls: "sd-brand", text: "SEDIMENT" });
    const tabs = bar.createDiv({ cls: "sd-tabs" });
    for (const [key, label] of TABS) {
      const button = tabs.createEl("button", {
        cls: `sd-tab ${key === this.tab ? "is-active" : ""}`,
        text: t(label),
        attr: { role: "tab", "aria-selected": key === this.tab ? "true" : "false" },
      });
      button.onclick = () => {
        this.tab = key;
        this.render();
      };
    }
    const spacer = bar.createDiv({ cls: "sd-spacer" });
    spacer.setAttribute("style", "flex:1");
    const refresh = bar.createEl("button", { cls: "sd-refresh", text: t("刷新") });
    refresh.onclick = () => this.render();
  }

  private renderToday(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
    const actions = body.createDiv({ cls: "sd-today-actions" });
    const memoAction = actions.createEl("button", {
      cls: "sd-today-action is-primary",
      text: t("记一条速记"),
    });
    memoAction.onclick = () => {
      const area = root.querySelector(".sd-quick-memo textarea") as HTMLTextAreaElement | null;
      area?.focus();
      area?.scrollIntoView({ block: "center" });
    };
    const taskAction = actions.createEl("button", {
      cls: "sd-today-action",
      text: t("查看今日任务"),
    });
    taskAction.onclick = () => {
      const tasks = root.querySelector(".sd-tasks") as HTMLElement | null;
      tasks?.scrollIntoView({ block: "center" });
    };
    const pomodoroAction = actions.createEl("button", {
      cls: "sd-today-action",
      text: t("开始专注"),
    });
    pomodoroAction.onclick = () => {
      if (!this.plugin.pomodoro.state().running) this.plugin.pomodoro.start();
    };
    const bento = body.createDiv({ cls: "sd-bento" });
    this.renderTodayCard(bento);
    this.renderQuickMemo(bento);
    this.renderTasksCard(bento);
    this.renderTodayAgent(bento);
    bento.querySelector(".sd-today")?.addClass("sd-bento-today");
    bento.querySelector(".sd-quick-memo")?.addClass("sd-bento-memo");
    bento.querySelector(".sd-tasks")?.addClass("sd-bento-tasks");
    bento.querySelector(".sd-agent-feed")?.addClass("sd-bento-agent");
  }

  private renderTodayCard(root: HTMLElement): void {
    const today = dateKey(new Date());
    const day = this.plugin.store.getDay(today);
    const streak = this.currentStreak();
    const goal = this.plugin.store.settings.dailyWordGoal || 1000;
    const card = root.createDiv({ cls: "sd-card sd-today" });
    const head = card.createDiv({ cls: "sd-today-head" });
    head.createDiv({ cls: "sd-today-title", text: t("今天") });
    head.createDiv({ cls: "sd-pill", text: day.contribution > 0 ? tf("{n} 分", { n: day.contribution }) : t("还没开始") });
    const goalRing = head.createDiv({ cls: "sd-goal-ring" });
    goalRing.innerHTML = this.goalRing(day.wordsAdded, goal);
    head.createEl("button", { cls: "sd-share-today", text: t("战报图片") }).onclick = () => {
      exportTodayReport({
        date: today,
        contribution: day.contribution,
        words: day.wordsAdded,
        streak,
        longest: this.longestStreak(),
        memos: this.plugin.store.data.memos.filter((memo) => memo.date === today).length,
        agentCalls: this.plugin.store.data.toolCalls.filter((call) => call.time.startsWith(today)).length,
      });
    };
    const row = card.createDiv({ cls: "sd-today-row" });
    row.createSpan({ text: tf("写作 {words} / {goal} 字", { words: day.wordsAdded, goal: goal.toLocaleString() }) });
    row.createSpan({ text: tf("连续 {streak} 天 · 最长 {longest} 天", { streak, longest: this.longestStreak() }) });
    const pomoButton = row.createEl("button", { cls: "sd-pomodoro-button" });
    pomoButton.onclick = () => this.plugin.pomodoro.toggle();
    this.updatePomodoroButton();
    const skip = row.createEl("button", { cls: "sd-pomodoro-skip", text: t("跳过") });
    skip.onclick = () => this.plugin.pomodoro.skip();
    const progress = card.createDiv({ cls: "sd-progress" });
    progress.createDiv({ cls: "sd-progress-fill" }).style.width = `${Math.min(100, (day.wordsAdded / goal) * 100)}%`;
  }

  private renderQuickMemo(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-quick-memo" });
    card.createDiv({ cls: "sd-card-title", text: t("快速速记") });
    const area = card.createEl("textarea", { cls: "kp-memo-input" });
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
      void this.plugin.memos.add(text).then((memo) => {
        if (memo) {
          area.value = "";
          try { localStorage.removeItem(draftKey); } catch {}
          status.setText(t("已保存"));
          this.render();
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

  private renderTodayAgent(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-agent-feed" });
    card.createDiv({ cls: "sd-card-title", text: t("今日 Agent 动态") });
    const today = dateKey(new Date());
    const calls = this.plugin.store.data.toolCalls.filter((call) => call.time.startsWith(today));
    const logs = this.plugin.store.data.workLogs.filter((log) => log.date === today);
    if (calls.length === 0 && logs.length === 0) {
      card.createDiv({ cls: "kp-empty", text: t("今天还没有智能体活动。") });
      return;
    }
    const list = card.createDiv({ cls: "sd-feed-list" });
    for (const call of calls.slice(0, 8)) {
      const row = list.createDiv({ cls: "sd-feed-row" });
      row.createSpan({ text: `${call.time.slice(11, 16)} · ${call.agent || "unknown"}` });
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

  private renderInsights(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
    const subnav = body.createDiv({ cls: "sd-subnav" });
    const anchors: Array<[string, string]> = [
      ["sd-overview", t("脉冲概览")],
      ["sd-heatmap", t("热力图")],
      ["sd-trend", t("写作趋势")],
      ["sd-folders", t("投入分布")],
      ["sd-yearly", t("年度画像")],
      ["sd-review-card", t("本周复盘")],
    ];
    for (const [id, label] of anchors) {
      const button = subnav.createEl("button", { text: label });
      button.onclick = () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    this.renderOverview(body);
    this.renderHeatmap(body, false);
    const secondary = body.createDiv({ cls: "sd-secondary sd-insights-secondary" });
    this.renderAnalytics(secondary);
    this.renderYearly(secondary);
    this.renderReview(body);
    const footer = this.renderFooter(body);
    footer.createEl("button", { text: t("月报") }).onclick = () => {
      new PosterModal(this.plugin.app, this.plugin.store, this.posterMonth).open();
    };
  }

  private renderAgentHub(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
    this.renderDrafts(body);
    this.renderTasksCard(body);
    this.renderAgentChanges(body);
    this.renderWorkLogs(body);
    const secondary = body.createDiv({ cls: "sd-secondary sd-agent-secondary" });
    this.renderAgentStatus(secondary);
    this.renderHeatmap(secondary, true);
    this.renderFooter(body);
  }

  private renderAgentChanges(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: t("Agent 变更审查") });
    const seen = new Set<string>();
    const calls = this.plugin.store.data.toolCalls
      .filter((call) => {
        if (!call.path || seen.has(call.path)) return false;
        seen.add(call.path);
        return true;
      })
      .filter((call) => /\.(md|json)$/.test(call.path))
      .slice(0, 8);

    if (calls.length === 0) {
      card.createDiv({ cls: "kp-empty", text: t("暂无 Agent 变更记录。") });
      return;
    }
    const list = card.createDiv({ cls: "sd-feed-list" });
    for (const call of calls) {
      const file = this.plugin.app.vault.getAbstractFileByPath(call.path);
      if (!(file instanceof TFile)) continue;
      const backups = listBackups(this.plugin, call.path);
      const row = list.createDiv({ cls: "sd-feed-row" });
      row.createSpan({ text: `${call.time.slice(5, 16)} · ${call.tool.replace(/^(GET|POST) /, "")}` });
      const actions = row.createDiv({ cls: "sd-audit-actions" });
      const type = call.tool.includes("patch")
        ? t("局部修改")
        : call.tool.includes("frontmatter")
          ? t("属性")
          : call.tool.includes("knowledge")
            ? t("沉淀")
            : call.tool.includes("memo")
              ? t("速记")
              : t("新建/覆盖");
      actions.createSpan({ cls: "sd-audit-badge", text: type });
      const open = actions.createEl("button", { text: file.basename, cls: "sd-audit-open" });
      open.onclick = () => void this.plugin.app.workspace.openLinkText(call.path, "", false);
      if (backups.length > 0) {
        actions.createEl("button", { text: tf("差异({n})", { n: backups.length }) }).onclick = () => {
          void this.plugin.app.vault.read(file).then((current) => {
            new DiffModal(
              this.plugin.app,
              `${file.basename} · ${t("变更对比")}`,
              readBackup(this.plugin, backups[0].name),
              current
            ).open();
          });
        };
        actions.createEl("button", { text: t("恢复") }).onclick = () => {
          if (!window.confirm(t("确认恢复这个 Agent 修改快照？当前笔记内容会被替换。"))) return;
          void restoreBackup(this.plugin, file, backups[0].name).then(() => {
            new Notice(t("已恢复到最近备份"));
            this.render();
          });
        };
      }
    }
  }

  private renderTasksCard(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-tasks" });
    card.createDiv({ cls: "sd-card-title", text: t("待办 · 今日 / 遗留 / Agent") });
    const list = card.createDiv({ cls: "sd-task-list" });
    list.createDiv({ cls: "kp-empty", text: t("加载中…") });
    void Promise.all([
      this.plugin.tasks.list("today"),
      this.plugin.tasks.list("overdue"),
      this.plugin.tasks.list("agent"),
    ]).then(([today, overdue, agent]) => {
      list.empty();
      const items = [...today.filter((task) => !task.checked), ...overdue, ...agent];
      if (items.length === 0) {
        list.createDiv({ cls: "kp-empty", text: t("没有未完成待办。") });
        return;
      }
      for (const task of items.slice(0, 12)) {
        const row = list.createDiv({ cls: "sd-task-item" });
        const button = row.createEl("button", {
          cls: "sd-task-open",
          text: task.text,
          attr: { title: task.path || t("Agent 任务") },
        });
        if (task.path) button.onclick = () => void this.plugin.app.workspace.openLinkText(task.path, "", false);
        else if (task.sourcePath)
          button.onclick = () => void this.openTaskSource(task.sourcePath, task.sourceLine);
        row.createDiv({
          cls: "sd-task-meta",
          text: task.path
            ? `${task.date} · ${task.path.split("/").pop()}:${task.line}`
            : task.sourcePath
              ? `Agent · ${t("原待办")} ${task.sourcePath.split("/").pop()}:${task.sourceLine ?? 1}`
              : `Agent · ${task.date}`,
        });
        const actions = row.createDiv({ cls: "sd-task-actions" });
        if (task.path) {
          actions.createEl("button", { text: t("完成") }).onclick = () => {
            if (!window.confirm(t("确认将此待办标记为完成？"))) return;
            void this.plugin.tasks.complete(task.path, task.line).then(() => {
              new Notice(t("待办已完成"));
              this.render();
            }).catch((error) => new Notice(error instanceof Error ? error.message : t("操作失败")));
          };
        } else if (task.memoId) {
          actions.createEl("button", { text: t("认领") }).onclick = () => {
            void this.plugin.agentApi.claimAgentTask(task.memoId!).then(() => {
              new Notice(t("任务已认领"));
              this.render();
            }).catch((error) => new Notice(error instanceof Error ? error.message : t("操作失败")));
          };
          actions.createEl("button", { text: t("完成") }).onclick = () => {
            if (!window.confirm(t("确认完成此 Agent 待办？"))) return;
            void this.plugin.agentApi.completeAgentTask(task.memoId!).then(() => {
              new Notice(t("Agent 待办已完成"));
              this.render();
            }).catch((error) => new Notice(error instanceof Error ? error.message : t("操作失败")));
          };
        }
      }
    });
  }

  private async openTaskSource(path?: string, line?: number): Promise<void> {
    if (!path) return;
    await this.plugin.app.workspace.openLinkText(path, "", false);
    if (line) {
      const editor = this.plugin.app.workspace.activeEditor?.editor;
      editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
    }
  }

  private renderAgentStatus(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: t("连接与调用状态") });
    const settings = this.plugin.store.settings;
    const calls = this.plugin.store.data.toolCalls;
    const byAgent: Record<string, number> = {};
    for (const call of calls) byAgent[call.agent || "unknown"] = (byAgent[call.agent || "unknown"] ?? 0) + 1;
    const grid = card.createDiv({ cls: "sd-status-grid" });
    const item = (label: string, value: string): void => {
      const box = grid.createDiv({ cls: "sd-status-item" });
      box.createDiv({ cls: "sd-mini-label", text: label });
      box.createDiv({ cls: "sd-mini-value", text: value });
    };
    item(t("本地 API"), settings.agentServerEnabled ? `${t("在线")} · ${settings.agentServerPort}` : t("未启用"));
    item(t("累计调用"), String(calls.length));
    for (const [agent, count] of Object.entries(byAgent)) item(agent, tf("{n} 次", { n: count }));
    const last = calls[0];
    if (last) card.createDiv({ cls: "sd-card-sub", text: `${t("最近调用")}：${last.time.slice(0, 16)} · ${last.tool}` });
  }

  private renderDrafts(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: t("AI 沉淀审核") });
    const drafts: TFile[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.sediment_status === "draft") drafts.push(file);
    }
    if (drafts.length === 0) {
      card.createDiv({ cls: "kp-empty", text: t("没有待审核的 AI 草稿。") });
      return;
    }
    const list = card.createDiv({ cls: "sd-draft-list" });
    for (const file of drafts.slice(0, 20)) {
      const item = list.createDiv({ cls: "sd-draft-card" });
      const title = item.createEl("button", { cls: "sd-draft-title", text: file.basename });
      title.onclick = () => void this.plugin.app.workspace.openLinkText(file.path, "", false);
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const category = String(cache?.frontmatter?.category ?? t("未分类"));
      item.createDiv({ cls: "sd-card-sub", text: `${category} · ${file.path}` });
      const actions = item.createDiv({ cls: "sd-draft-actions" });
      actions.createEl("button", { text: t("采纳并归档") }).onclick = () => {
        void this.plugin.agentApi.updateFrontmatter(file.path, { sediment_status: "accepted" }).then(() => {
          new Notice(t("已采纳"));
          this.render();
        });
      };
      actions.createEl("button", { text: t("合并到关联笔记") }).onclick = () => void this.mergeDraft(file);
      actions.createEl("button", { text: t("驳回删除") }).onclick = () => {
        if (!window.confirm(t("确认驳回并移入回收站？草稿可在回收站恢复。"))) return;
        void this.plugin.app.vault.trash(file, false).then(() => {
          new Notice(t("已驳回并移入回收站"));
          this.render();
        });
      };
    }
  }

  private async mergeDraft(file: TFile): Promise<void> {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const links = cache?.frontmatter?.links;
    const first = Array.isArray(links) && links.length > 0 ? String(links[0]) : "";
    if (!first) {
      new Notice(t("这张草稿没有关联笔记，无法合并"));
      return;
    }
    const target = this.plugin.app.vault
      .getMarkdownFiles()
      .find((item) => item.basename === first || item.path === first);
    if (!target) {
      new Notice(tf("找不到关联笔记：{name}", { name: first }));
      return;
    }
    if (!window.confirm(t("合并后草稿将移入回收站，是否继续？"))) return;
    const source = await this.plugin.app.vault.read(file);
    const body = source.replace(/^---[\s\S]*?---\s*/, "");
    await this.plugin.app.vault.process(target, (data) => `${data.trimEnd()}\n\n${body.trim()}\n`);
    await this.plugin.app.vault.trash(file, false);
    new Notice(tf("已合并到 {name}", { name: target.basename }));
    this.render();
  }

  private renderWorkLogs(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: t("智能体工作日志") });
    const logs = this.plugin.store.data.workLogs.slice(0, 10);
    if (logs.length === 0) {
      card.createDiv({ cls: "kp-empty", text: t("还没有工作日志。") });
      return;
    }
    const list = card.createDiv({ cls: "sd-feed-list" });
    for (const log of logs) {
      const row = list.createDiv({ cls: "sd-feed-row" });
      row.createSpan({ text: `${log.date} ${log.time} · ${log.agent}` });
      row.createEl("strong", { text: log.task });
    }
  }

  private renderFooter(root: HTMLElement): HTMLElement {
    const footer = root.createDiv({ cls: "sd-footer" });
    footer.createSpan({ text: `Sediment ${this.plugin.manifest.version} · ${t("数据只留在本地")}` });
    const changelog = footer.createEl("button", { text: t("更新记录") });
    changelog.onclick = () => new ChangelogModal(this.plugin.app).open();
    const styleButton = footer.createEl("button", { text: t("换画风") });
    styleButton.onclick = () => this.cycleArtStyle();
    return footer;
  }

  private analyticsCard(root: HTMLElement, title: string, subtitle = ""): HTMLElement {
    const card = root.createDiv({ cls: "sd-card" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: title });
    if (subtitle) head.createDiv({ cls: "sd-card-sub", text: subtitle });
    return card;
  }

  private barChart(values: number[], color = "var(--interactive-accent)", refs: ChartRef[] = []): string {
    const width = 900;
    const height = 120;
    const pad = 4;
    const max = Math.max(1, ...values, ...refs.map((ref) => ref.value));
    const barWidth = (width - pad * 2) / Math.max(1, values.length);
    const rects = values
      .map((value, index) => {
        const h = (value / max) * (height - pad * 2);
        return `<rect x="${(pad + index * barWidth).toFixed(1)}" y="${(height - pad - h).toFixed(1)}" width="${(barWidth * 0.72).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${value > 0 ? 0.8 : 0.12}"/>`;
      })
      .join("");
    const refLines = this.referenceLines(refs, max, width, height, pad);
    return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}${refLines}</svg>`;
  }

  private multiLine(series: Array<{ values: number[]; color: string }>, refs: ChartRef[] = []): string {
    const width = 900;
    const height = 140;
    const pad = 6;
    const max = Math.max(1, ...series.flatMap((item) => item.values), ...refs.map((ref) => ref.value));
    const lines = series
      .map((item) => {
        const points = item.values
          .map((value, index) => {
            const x = pad + (index / Math.max(1, item.values.length - 1)) * (width - pad * 2);
            const y = height - pad - (value / max) * (height - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      })
      .join("");
    const refLines = this.referenceLines(refs, max, width, height, pad);
    return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines}${refLines}</svg>`;
  }

  /** 数字参照线：均值/目标等水平虚线，右上角带数值标签。 */
  private referenceLines(refs: ChartRef[], max: number, width: number, height: number, pad: number): string {
    return refs
      .filter((ref) => ref.value > 0)
      .map((ref) => {
        const y = height - pad - (Math.min(ref.value, max) / max) * (height - pad * 2);
        const stroke = ref.color ?? "var(--text-muted)";
        return (
          `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${width - pad}" y2="${y.toFixed(1)}" stroke="${stroke}" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" opacity="0.75"/>` +
          `<text x="${width - pad - 2}" y="${Math.max(9, y - 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${stroke}">${ref.label}</text>`
        );
      })
      .join("");
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private currentStreak(): number {
    let streak = 0;
    let cursor = new Date();
    if (this.plugin.store.getDay(dateKey(cursor)).contribution === 0) cursor = addDays(cursor, -1);
    while (this.plugin.store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  private longestStreak(): number {
    const keys = Object.keys(this.plugin.store.data.days)
      .filter((key) => this.plugin.store.getDay(key).contribution > 0)
      .sort();
    let longest = 0;
    let run = 0;
    let previous = "";
    for (const key of keys) {
      run = previous && dateKey(addDays(parseKey(previous), 1)) === key ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = key;
    }
    return longest;
  }

  private showHeatTooltip(event: MouseEvent, key: string): void {
    this.hideHeatTooltip();
    const day = this.plugin.store.getDay(key);
    const tip = document.createElement("div");
    tip.className = "sd-heat-tooltip";
    tip.createDiv({ cls: "sd-tip-date", text: key });
    tip.createDiv({
      cls: "sd-tip-metric",
      text: `贡献 ${day.contribution} 分 · 新增 ${day.wordsAdded} 字${day.aiWordsAdded > 0 ? `（AI ${day.aiWordsAdded}）` : ""}`,
    });
    const notes = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.includes(key))
      .map((file) => file.basename)
      .slice(0, 4);
    if (notes.length > 0) tip.createDiv({ cls: "sd-tip-notes", text: `笔记：${notes.join("、")}` });
    const memos = this.plugin.store.data.memos.filter((memo) => memo.date === key).slice(0, 2);
    if (memos.length > 0) tip.createDiv({ cls: "sd-tip-notes", text: `速记：${memos.map((memo) => memo.text).join(" / ")}` });
    document.body.appendChild(tip);
    this.heatTooltip = tip;
    this.moveHeatTooltip(event);
  }

  private moveHeatTooltip(event: MouseEvent): void {
    if (!this.heatTooltip) return;
    this.heatTooltip.style.left = `${event.clientX + 14}px`;
    this.heatTooltip.style.top = `${event.clientY + 14}px`;
  }

  private hideHeatTooltip(): void {
    this.heatTooltip?.remove();
    this.heatTooltip = null;
  }

  private renderOverview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-overview", attr: { id: "sd-overview" } });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: t("知识脉冲概览") });
    head.createDiv({ cls: "sd-card-sub", text: `${t("近")} ${t(RANGE_OPTIONS.find((r) => r[0] === this.range)?.[1] ?? "")} · ${t("可靠记录")}` });

    const ranges = card.createDiv({ cls: "sd-ranges" });
    for (const [key, label] of RANGE_OPTIONS) {
      const button = ranges.createEl("button", {
        cls: `sd-range ${key === this.range ? "is-active" : ""}`,
        text: t(label),
      });
      button.onclick = () => {
        this.range = key;
        this.render();
      };
    }

    const keys = this.chartKeys();
    const total = keys.reduce((sum, key) => sum + this.value(key), 0);
    const active = keys.filter((key) => this.value(key) > 0).length;
    const best = keys.reduce(
      (bestDay, day) => (this.value(day) > this.value(bestDay) ? day : bestDay),
      keys[0] ?? dateKey(new Date())
    );
    const grid = card.createDiv({ cls: "sd-overview-grid" });
    const left = grid.createDiv({ cls: "sd-overview-left" });
    left.createDiv({ cls: "sd-metric-label", text: t("累计贡献分") });
    left.createDiv({ cls: "sd-metric-value", text: String(total) });
    left.createDiv({ cls: "sd-metric-hint", text: tf("{active} 天有记录 · 日均 {avg} 分", { active, avg: keys.length ? Math.round(total / keys.length) : 0 }) });
    const overviewValues = keys.map((key) => this.value(key));
    const overviewMean = this.mean(overviewValues);
    left.innerHTML += this.sparkline(
      overviewValues,
      overviewMean > 0 ? [{ value: overviewMean, label: tf("均值 {n}", { n: Math.round(overviewMean) }) }] : []
    );

    const right = grid.createDiv({ cls: "sd-overview-right" });
    const mini = (label: string, value: string, hint: string, ring?: string): void => {
      const item = right.createDiv({ cls: "sd-mini" });
      item.createDiv({ cls: "sd-mini-label", text: label });
      item.createDiv({ cls: "sd-mini-value", text: value });
      item.createDiv({ cls: "sd-mini-hint", text: hint });
      if (ring) item.createDiv({ cls: "sd-mini-ring" }).innerHTML = ring;
    };
    mini(t("活跃天数"), `${active} / ${keys.length}`, t("有记录的日子"), this.ring(active, keys.length));
    mini(t("当前连续"), tf("{n} 天", { n: this.currentStreak() }), tf("最长 {n} 天 · 按全部历史", { n: this.longestStreak() }));
    const investedMinutes = keys.reduce((sum, key) => sum + (this.plugin.store.getDay(key).activeMinutes + this.plugin.store.getDay(key).focusMinutes), 0);
    mini(t("投入时间"), tf("{n} 小时", { n: Math.round(investedMinutes / 60 * 10) / 10 }), t("交互 / 专注"));
    mini(t("最高的一天"), this.value(best) > 0 ? String(this.value(best)) : "—", best);
  }

  private sparkline(values: number[], refs: ChartRef[] = []): string {
    const width = 620;
    const height = 96;
    const pad = 10;
    const max = Math.max(1, ...values, ...refs.map((ref) => ref.value));
    const coordinates = values.map((value, index) => ({
      x: pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2),
      y: height - pad - (value / max) * (height - pad * 2),
      value,
    }));
    const points = coordinates.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const dots = coordinates
      .filter((point) => point.value > 0)
      .map(
        (point) =>
          `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3" fill="var(--interactive-accent)" stroke="var(--background-primary)" stroke-width="1.5"/>`
      )
      .join("");
    const peakIndex = values.indexOf(max);
    const peak = coordinates[peakIndex];
    const peakLabel =
      peak && max > 0
        ? `<text x="${peak.x.toFixed(1)}" y="${Math.max(10, peak.y - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--text-normal)">${max}</text>`
        : "";
    const refLines = this.referenceLines(refs, max, width, height, pad);
    return `<svg class="sd-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
<defs><linearGradient id="sd-spark-fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="var(--interactive-accent)" stop-opacity="0.28"/>
<stop offset="100%" stop-color="var(--interactive-accent)" stop-opacity="0"/>
</linearGradient></defs>
<polygon points="${pad},${height - pad} ${points} ${width - pad},${height - pad}" fill="url(#sd-spark-fill)"/>
<polyline points="${points}" fill="none" stroke="var(--interactive-accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
${refLines}${dots}${peakLabel}</svg>`;
  }

  private ring(active: number, total: number): string {
    const radius = 26;
    const circumference = 2 * Math.PI * radius;
    const ratio = total > 0 ? active / total : 0;
    return `<svg viewBox="0 0 68 68" class="sd-ring">
<circle cx="34" cy="34" r="${radius}" fill="none" stroke="var(--background-modifier-border)" stroke-width="7"/>
<circle cx="34" cy="34" r="${radius}" fill="none" stroke="var(--interactive-accent)" stroke-width="7"
  stroke-dasharray="${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 34 34)"/>
<text x="34" y="40" text-anchor="middle" font-size="15" fill="var(--text-normal)">${active}</text></svg>`;
  }

  private goalRing(value: number, goal: number): string {
    const radius = 18;
    const circumference = 2 * Math.PI * radius;
    const ratio = Math.min(1, value / Math.max(1, goal));
    const overflow = value > goal;
    return `<svg viewBox="0 0 46 46" class="sd-goal-svg${overflow ? " is-overflow" : ""}">
<circle cx="23" cy="23" r="${radius}" fill="none" stroke="var(--background-modifier-border)" stroke-width="4"/>
<circle cx="23" cy="23" r="${radius}" fill="none" stroke="var(--interactive-accent)" stroke-width="4" stroke-linecap="round"
  stroke-dasharray="${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 23 23)"/>
<text x="23" y="27" text-anchor="middle" font-size="11" fill="var(--text-normal)">${Math.round(ratio * 100)}%</text></svg>`;
  }

  private renderHeatmap(root: HTMLElement, dual: boolean): void {
    const card = root.createDiv({ cls: "sd-card sd-heatmap", attr: { id: "sd-heatmap" } });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: dual ? t("人机双色热力图") : t("年度知识活跃脉冲") });
    head.createDiv({ cls: "sd-card-sub", text: `${t("近 53 周")} · ${this.metricLabel()}` });

    const metrics = card.createDiv({ cls: "sd-metrics" });
    for (const metric of METRICS) {
      const button = metrics.createEl("button", {
        cls: `sd-metric-tab ${metric.key === this.metric ? "is-active" : ""}`,
        text: t(metric.label),
        attr: { title: t(metric.hint) },
      });
      button.onclick = () => {
        this.metric = metric.key;
        this.plugin.store.settings.heatmapMetric = metric.key;
        void this.plugin.saveSettings();
        this.render();
      };
    }

    const store = this.plugin.store;
    const weekStart = store.settings.weekStart;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = addDays(startOfWeekFor(today, weekStart), -52 * 7);
    const wrap = card.createDiv({ cls: "kp-heatmap-wrap" });
    const grid = wrap.createDiv({ cls: "kp-grid" });
    const labels = grid.createDiv({ cls: "kp-weekdays" });
    for (let row = 0; row < 7; row += 1) {
      const weekday = (row + weekStart) % 7;
      labels.createDiv({ cls: "kp-weekday", text: row % 2 === 0 ? WEEKDAYS[weekday] : "" });
    }
    const main = grid.createDiv({ cls: "kp-main" });
    const months = main.createDiv({ cls: "kp-months" });
    months.style.gridTemplateColumns = "repeat(53, 15px)";
    const columns = main.createDiv({ cls: "kp-columns" });
    const cells: Array<{ key: string; value: number; date: Date; el: HTMLElement; ai: number }> = [];

    for (let week = 0; week < 53; week += 1) {
      const column = columns.createDiv({ cls: "kp-col" });
      for (let day = 0; day < 7; day += 1) {
        const date = addDays(start, week * 7 + day);
        const key = dateKey(date);
        const record = store.getDay(key);
        const cellValue = Number(record[this.metric]) || 0;
        const element = column.createDiv({
          cls: "kp-cell",
          attr: { "data-date": key, role: "gridcell", tabindex: "-1" },
        });
        if (date > today) {
          element.addClass("kp-future");
          element.setAttribute("aria-disabled", "true");
        } else {
          element.setAttribute("aria-label", `${key} · ${this.metricLabel()} ${cellValue}`);
          element.onclick = () => {
            this.hideHeatTooltip();
            this.selected = key;
            this.pendingFocusDate = key;
            this.render();
          };
          element.onmouseenter = (event) => this.showHeatTooltip(event, key);
          element.onmousemove = (event) => this.moveHeatTooltip(event);
          element.onmouseleave = () => this.hideHeatTooltip();
        }
        cells.push({ key, value: cellValue, date, el: element, ai: record.aiWordsAdded });
      }
    }
    for (const cell of cells) {
      if (cell.date.getDate() !== 1) continue;
      const column = Math.floor((cell.date.getTime() - start.getTime()) / (7 * 86400000));
      if (column < 0 || column >= 53) continue;
      const label = months.createDiv({ cls: "kp-month", text: `${cell.date.getMonth() + 1}月` });
      label.style.gridColumn = String(column + 1);
    }
    const max = Math.max(1, ...cells.map((cell) => cell.value));
    for (const cell of cells) {
      const level = cell.value <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((cell.value / max) * 4)));
      cell.el.addClass(`kp-lvl-${level}`);
      if (dual && this.metric === "wordsAdded" && cell.value > 0) {
        const ratio = Math.min(100, (cell.ai / cell.value) * 100);
        cell.el.style.background = `linear-gradient(90deg, var(--interactive-accent) ${ratio}%, var(--text-faint) ${ratio}%)`;
      }
      cell.el.setAttribute(
        "title",
        dual && this.metric === "wordsAdded"
          ? `${cell.key} · 总 ${cell.value} 字，其中 AI ${cell.ai} 字`
          : `${cell.key} · ${this.metricLabel()} ${cell.value}`
      );
    }
    const legend = wrap.createDiv({ cls: "kp-legend" });
    legend.createSpan({ text: dual ? t("人") : t("少") });
    for (let level = 0; level <= 4; level += 1) legend.createDiv({ cls: `kp-cell kp-lvl-${level}` });
    legend.createSpan({ text: dual ? t("AI") : t("多") });

    // 键盘导航：roving tabindex，方向键在周/日间移动，Enter/空格选中。
    const selectable = cells.filter((cell) => !cell.el.hasClass("kp-future"));
    const focusKey =
      this.selected && selectable.some((cell) => cell.key === this.selected)
        ? this.selected
        : selectable[selectable.length - 1]?.key;
    for (const cell of selectable) cell.el.setAttribute("tabindex", cell.key === focusKey ? "0" : "-1");
    columns.setAttribute("role", "grid");
    columns.setAttribute("aria-label", t("年度活跃热力图，方向键移动，回车选中"));
    columns.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      const index = cells.findIndex((cell) => cell.el === target);
      if (index < 0) return;
      const deltas: Record<string, number> = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
      if (event.key in deltas) {
        event.preventDefault();
        const next = index + deltas[event.key];
        if (next < 0 || next >= cells.length || cells[next].el.hasClass("kp-future")) return;
        cells[index].el.setAttribute("tabindex", "-1");
        cells[next].el.setAttribute("tabindex", "0");
        cells[next].el.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.hideHeatTooltip();
        this.selected = cells[index].key;
        this.pendingFocusDate = cells[index].key;
        this.render();
      }
    });

    if (this.selected) {
      const day = store.getDay(this.selected);
      const detail = card.createDiv({ cls: "sd-day-detail" });
      detail.createDiv({ cls: "sd-day-head", text: this.selected });
      const rows: Array<[string, number]> = [
        ["贡献分", day.contribution],
        ["新增词", day.wordsAdded],
        ["AI 新增词", day.aiWordsAdded],
        ["编辑会话", day.edits],
        ["新建笔记", day.notesCreated],
        ["完成任务", day.tasksCompleted],
      ];
      for (const [label, value] of rows) {
        const item = detail.createDiv({ cls: "sd-day-item" });
        item.createDiv({ cls: "kp-detail-label", text: t(label) });
        item.createEl("strong", { text: String(value) });
      }
    }
  }

  private renderAnalytics(root: HTMLElement): void {
    const keys = this.chartKeys();
    const days = keys.map((key) => this.plugin.store.getDay(key));
    const label = t(RANGE_OPTIONS.find((range) => range[0] === this.range)?.[1] ?? "");

    const trend = this.analyticsCard(root, t("写作与时间趋势"), label);
    trend.setAttribute("id", "sd-trend");
    const trendTabs = trend.querySelector(".sd-card-head")?.createDiv({ cls: "sd-trend-tabs" });
    const trendOptions: Array<["writing" | "changes" | "time" | "source", string]> = [
      ["writing", t("每日写作")],
      ["changes", t("写作变化")],
      ["time", t("时间投入")],
      ["source", t("写作来源")],
    ];
    for (const [key, title] of trendOptions) {
      const button = trendTabs?.createEl("button", {
        cls: key === this.trendTab ? "is-active" : "",
        text: title,
      });
      if (button) button.onclick = () => {
        this.trendTab = key;
        this.render();
      };
    }
    const trendContent = trend.createDiv({ cls: "sd-trend-content" });
    if (this.trendTab === "writing") {
      const writingValues = days.map((day) => day.wordsAdded);
      const goal = this.plugin.store.settings.dailyWordGoal || 0;
      const writingMean = this.mean(writingValues);
      const writingRefs: ChartRef[] = [];
      if (goal > 0) writingRefs.push({ value: goal, label: tf("目标 {n}", { n: goal }), color: "var(--text-accent)" });
      if (writingMean > 0) writingRefs.push({ value: writingMean, label: tf("均值 {n}", { n: Math.round(writingMean) }) });
      trendContent.innerHTML += this.barChart(writingValues, "var(--interactive-accent)", writingRefs);
    } else if (this.trendTab === "changes") {
      const addedValues = days.map((day) => day.wordsAdded);
      const addedMean = this.mean(addedValues);
      trendContent.innerHTML += this.multiLine(
        [
          { values: addedValues, color: "var(--interactive-accent)" },
          { values: days.map((day) => day.wordsRemoved), color: "var(--text-faint)" },
          { values: days.map((day) => day.capturedWords), color: "var(--text-muted)" },
        ],
        addedMean > 0 ? [{ value: addedMean, label: tf("新增均值 {n}", { n: Math.round(addedMean) }) }] : []
      );
    } else if (this.trendTab === "time") {
      const activeValues = days.map((day) => day.activeMinutes);
      const activeMean = this.mean(activeValues);
      trendContent.innerHTML += this.multiLine(
        [
          { values: activeValues, color: "var(--interactive-accent)" },
          { values: days.map((day) => day.focusMinutes), color: "var(--text-faint)" },
        ],
        activeMean > 0 ? [{ value: activeMean, label: tf("活跃均值 {n}", { n: Math.round(activeMean) }) }] : []
      );
    } else {
      const totalWords = days.reduce((sum, day) => sum + day.wordsAdded, 0);
      const captured = days.reduce((sum, day) => sum + day.capturedWords, 0);
      const typed = Math.max(0, totalWords - captured);
      const bar = trendContent.createDiv({ cls: "sd-source-bar" });
      bar.createDiv({ cls: "sd-source-typed" }).style.width = `${totalWords ? (typed / totalWords) * 100 : 0}%`;
      bar.createDiv({ cls: "sd-source-capture" }).style.width = `${totalWords ? (captured / totalWords) * 100 : 0}%`;
      trendContent.createDiv({ cls: "sd-card-sub", text: tf("逐步写入 {typed} 字 · 大段捕获 {captured} 字", { typed, captured }) });
    }

    const folders = this.analyticsCard(root, t("投入去向"), t("按目录统计（笔记 × 天）"));
    folders.setAttribute("id", "sd-folders");
    const folderTotals = new Map<string, number>();
    for (const day of days) {
      for (const [folder, words] of Object.entries(day.folderWords)) {
        folderTotals.set(folder, (folderTotals.get(folder) ?? 0) + words);
      }
    }
    const sortedFolders = [...folderTotals.entries()].sort((a, b) => b[1] - a[1]);
    const folderWordsTotal = sortedFolders.reduce((sum, [, words]) => sum + words, 0);
    const folderList = folders.createDiv({ cls: "sd-folder-list" });
    for (const [index, [folder, words]] of
      (this.foldersExpanded ? sortedFolders.slice(0, 20) : sortedFolders.slice(0, 6)).entries()) {
      const row = folderList.createDiv({ cls: "sd-folder-row" });
      row.createSpan({ cls: "sd-folder-rank", text: String(index + 1) });
      row.createSpan({ cls: "sd-folder-name", text: folder || "/", attr: { title: folder || "/" } });
      const track = row.createDiv({ cls: "sd-folder-track" });
      const percent = folderWordsTotal > 0 ? (words / folderWordsTotal) * 100 : 0;
      track.createDiv({ cls: "sd-folder-fill" }).style.width = `${percent}%`;
      row.createEl("strong", { text: tf("{words} 字 · {percent}%", { words, percent: percent.toFixed(0) }) });
    }
    if (sortedFolders.length > 6) {
      folders.createEl("button", { text: this.foldersExpanded ? t("收起") : tf("展开其余 {n} 项", { n: sortedFolders.length - 6 }) }).onclick = () => {
        this.foldersExpanded = !this.foldersExpanded;
        this.render();
      };
    }

    const rhythm = this.analyticsCard(root, t("投入节律矩阵"), t("六项指标按天对齐"));
    const rhythmHead = rhythm.querySelector(".sd-card-head");
    const rhythmTabs = rhythmHead?.createDiv({ cls: "sd-trend-tabs" });
    const rhythmOptions: Array<["matrix" | "hours", string]> = [
      ["matrix", t("节律矩阵")],
      ["hours", t("活跃时段")],
    ];
    for (const [key, title] of rhythmOptions) {
      const button = rhythmTabs?.createEl("button", {
        cls: key === this.rhythmTab ? "is-active" : "",
        text: title,
      });
      if (button) button.onclick = () => {
        this.rhythmTab = key;
        this.render();
      };
    }

    if (this.rhythmTab === "hours") {
      const hourly = Array.from({ length: 24 }, (_, hour) =>
        days.reduce((sum, day) => sum + (day.hourlyWords[hour] ?? 0), 0)
      );
      const hourlyMean = this.mean(hourly);
      rhythm.innerHTML += this.barChart(
        hourly,
        "var(--interactive-accent)",
        hourlyMean > 0 ? [{ value: hourlyMean, label: tf("均值 {n}", { n: Math.round(hourlyMean) }) }] : []
      );
      const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
      for (const key of keys) {
        const day = this.plugin.store.getDay(key);
        const weekday = parseKey(key).getDay();
        for (let hour = 0; hour < 24; hour += 1) weekdayHour[weekday][hour] += day.hourlyWords[hour] ?? 0;
      }
      const hourMax = Math.max(1, ...weekdayHour.flat());
      const pattern = rhythm.createDiv({ cls: "sd-hour-grid" });
      for (let weekday = 0; weekday < 7; weekday += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          const cell = pattern.createDiv({ cls: "sd-hour-cell" });
          const ratio = weekdayHour[weekday][hour] / hourMax;
          cell.setAttribute("style", `background:var(--interactive-accent);opacity:${ratio > 0 ? 0.1 + ratio * 0.9 : 0.05}`);
        }
      }
      return;
    }

    if (rhythmHead) {
      const toggle = rhythmHead.createEl("button", {
        text: this.rhythmActiveOnly ? t("仅活跃日期") : t("全部日期"),
      });
      toggle.onclick = () => {
        this.rhythmActiveOnly = !this.rhythmActiveOnly;
        this.render();
      };
    }
    const grid = rhythm.createDiv({ cls: "sd-rhythm" });
    const metricKeys = ["contribution", "wordsAdded", "activeMinutes", "focusMinutes", "notesCreated", "tasksCompleted"] as const;
    grid.createDiv({ cls: "sd-rhythm-label", text: t("日期") });
    for (const key of metricKeys) grid.createDiv({ cls: "sd-rhythm-label", text: this.shortMetric(key) });
    const maxima = metricKeys.map((key) => Math.max(1, ...days.map((day) => Number(day[key]) || 0)));
    const rhythmKeys = (this.rhythmActiveOnly
      ? keys.filter((key) => this.plugin.store.getDay(key).contribution > 0)
      : keys
    ).slice(-30);
    for (const key of rhythmKeys) {
      const day = this.plugin.store.getDay(key);
      grid.createDiv({ cls: "sd-rhythm-label", text: key.slice(5) });
      metricKeys.forEach((metric, index) => {
        const value = Number(day[metric]) || 0;
        const cell = grid.createDiv({ cls: `sd-rhythm-cell${value > 0 ? "" : " is-empty"}` });
        cell.setAttribute("style", `background:var(--interactive-accent);opacity:${value > 0 ? 0.1 + 0.9 * (value / maxima[index]) : 0.04}`);
      });
    }
  }

  private shortMetric(key: string): string {
    const names: Record<string, string> = {
      contribution: "贡献",
      wordsAdded: "新增词",
      activeMinutes: "活跃",
      focusMinutes: "专注",
      notesCreated: "新笔记",
      tasksCompleted: "任务",
    };
    return names[key] ? t(names[key]) : key;
  }

  private moonGlyph(date: Date): string {
    const synodic = 29.530588853 * 86400000;
    const known = new Date(2000, 0, 6, 18, 14).getTime();
    const phase = ((((date.getTime() - known) / synodic) % 1) + 1) % 1;
    if (phase < 0.03 || phase > 0.97) return "🌑";
    if (phase < 0.22) return "🌒";
    if (phase < 0.28) return "🌓";
    if (phase < 0.47) return "🌔";
    if (phase < 0.53) return "🌕";
    if (phase < 0.72) return "🌖";
    if (phase < 0.78) return "🌗";
    return "🌘";
  }

  private renderYearly(root: HTMLElement): void {
    const year = new Date().getFullYear();
    const entries = Object.entries(this.plugin.store.data.days).filter(([key]) => key.startsWith(`${year}-`));
    const card = this.analyticsCard(root, t("年度画像"), tf("{year} 年", { year }));
    card.setAttribute("id", "sd-yearly");
    const yearlyTabs = card.querySelector(".sd-card-head")?.createDiv({ cls: "sd-trend-tabs" });
    const yearlyOptions: Array<["wheel" | "fingerprint" | "moon", string]> = [
      ["wheel", t("年轮")],
      ["fingerprint", t("指纹")],
      ["moon", t("月相")],
    ];
    for (const [key, title] of yearlyOptions) {
      const button = yearlyTabs?.createEl("button", {
        cls: key === this.yearlyTab ? "is-active" : "",
        text: title,
      });
      if (button) button.onclick = () => {
        this.yearlyTab = key;
        this.render();
      };
    }

    if (this.yearlyTab === "wheel") {
      const petals = entries
        .map(([key, day]) => {
          const dayOfYear = Math.floor((parseKey(key).getTime() - new Date(year, 0, 0).getTime()) / 86400000);
          const angle = (dayOfYear / 365) * Math.PI * 2 - Math.PI / 2;
          const length = 14 + Math.min(54, day.contribution * 3);
          const x1 = 110 + Math.cos(angle) * 36;
          const y1 = 110 + Math.sin(angle) * 36;
          const x2 = 110 + Math.cos(angle) * (36 + length);
          const y2 = 110 + Math.sin(angle) * (36 + length);
          const color = day.contribution > 0 ? "var(--interactive-accent)" : "var(--background-modifier-border)";
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
        })
        .join("");
      const tracks = [
        `<circle cx="110" cy="110" r="36" fill="none" stroke="var(--background-modifier-border)" stroke-width="1"/>`,
        `<circle cx="110" cy="110" r="72" fill="none" stroke="var(--background-modifier-border)" stroke-width="1" stroke-dasharray="3 5"/>`,
        `<circle cx="110" cy="110" r="108" fill="none" stroke="var(--background-modifier-border)" stroke-width="1"/>`,
      ].join("");
      const monthTicks = Array.from({ length: 12 }, (_, month) => {
        const angle = (month / 12) * Math.PI * 2 - Math.PI / 2;
        const inner = 106;
        const outer = 116;
        const x1 = 110 + Math.cos(angle) * inner;
        const y1 = 110 + Math.sin(angle) * inner;
        const x2 = 110 + Math.cos(angle) * outer;
        const y2 = 110 + Math.sin(angle) * outer;
        const lx = 110 + Math.cos(angle) * 124;
        const ly = 110 + Math.sin(angle) * 124;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="9" text-anchor="middle" dominant-baseline="middle" fill="var(--text-faint)">${month + 1}月</text>`;
      }).join("");
      const watermark = `<text x="110" y="116" text-anchor="middle" font-size="26" font-weight="600" fill="var(--text-faint)" opacity="0.18">${year}</text>`;
      card.innerHTML += `<svg viewBox="0 0 220 220" class="sd-wheel">${tracks}${monthTicks}${watermark}${petals}</svg>`;
      return;
    }

    if (this.yearlyTab === "fingerprint") {
      const fingerprintSvg = Array.from({ length: 12 }, (_, month) => {
        const bars = Array.from({ length: 31 }, (_, index) => {
          const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
          const value = this.plugin.store.getDay(key).contribution;
          return `<rect x="${index * 13}" y="${month * 20}" width="9" height="13" rx="2" fill="var(--interactive-accent)" opacity="${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}"/>`;
        }).join("");
        return `<text x="0" y="${month * 20 + 11}" font-size="9" fill="var(--text-faint)">${month + 1}</text>${bars}`;
      }).join("");
      card.innerHTML += `<svg viewBox="0 0 420 248" class="sd-fingerprint">${fingerprintSvg}</svg>`;
      return;
    }

    for (let month = 0; month < 12; month += 1) {
      const section = card.createDiv({ cls: "sd-calendar-month" });
      section.createDiv({ cls: "sd-calendar-title", text: `${month + 1} 月` });
      const grid = section.createDiv({ cls: "sd-calendar-grid" });
      for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day += 1) {
        const date = new Date(year, month, day);
        const value = this.plugin.store.getDay(dateKey(date)).contribution;
        const cell = grid.createDiv({ cls: "sd-calendar-cell", attr: { title: `${dateKey(date)} · ${value} 分` } });
        cell.createDiv({ cls: "sd-calendar-moon", text: this.moonGlyph(date) });
        cell.createDiv({ cls: "sd-calendar-value", text: value > 0 ? String(value) : "·" });
      }
    }
  }

  private renderReview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view", attr: { id: "sd-review-card" } });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: t("知识复盘 · 本周") });
    const markdown = buildWeeklyReview(this.plugin.store, new Date());
    head.createEl("button", { text: t("复制 Markdown") }).onclick = () => {
      void navigator.clipboard.writeText(markdown).then(() => new Notice(t("周复盘已复制")));
    };
    const preview = card.createDiv({ cls: "sd-review-preview" });
    void MarkdownRenderer.render(this.plugin.app, markdown, preview, "", this);
  }

  private bannerSvg(): string {
    const style = this.plugin.store.settings.artStyle;
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const daylight = hour >= 6 && hour < 18;
    const x = 180 + (hour / 24) * 1240;
    const y = Math.max(34, 60 - Math.sin(((hour - 6) / 12) * Math.PI) * 34);
    const celestial = daylight
      ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="34" fill="#ffe08a"/>`
      : `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="30" fill="#f2f0dc"/><text x="${x.toFixed(0)}" y="${(y + 10).toFixed(0)}" font-size="30" text-anchor="middle">${this.moonGlyph(now)}</text>`;
    if (style === "ink") {
      return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="#e9e7e1"/>
<path d="M0 150 q300 -90 560 10 q260 -120 520 -20 q260 -70 520 30 L1600 300 L0 300 Z" fill="#9aa0a3" opacity="0.5"/>
<path d="M0 210 q240 -70 480 10 q300 -90 560 -10 q260 -50 560 20 L1600 300 L0 300 Z" fill="#5f676c" opacity="0.6"/>
${celestial}
<rect x="1460" y="40" width="62" height="62" fill="#b6473f" opacity="0.85"/>
<text x="1491" y="82" font-size="30" text-anchor="middle" fill="#fff">沉</text></svg>`;
    }
    if (style === "city") {
      const buildings = Array.from({ length: 34 }, (_, index) => {
        const width = 28 + (index % 4) * 6;
        const height = 70 + ((index * 37) % 110);
        const bx = index * 48;
        const windows = Array.from({ length: 4 }, (_, row) =>
          Array.from({ length: 3 }, (_, col) =>
            `<rect x="${bx + 7 + col * 8}" y="${300 - height + 12 + row * 16}" width="4" height="6" fill="${(index + row + col) % 3 === 0 ? "#ffd987" : "#dbe6f0"}" opacity="0.7"/>`
          ).join("")
        ).join("");
        return `<rect x="${bx}" y="${300 - height}" width="${width}" height="${height}" fill="${daylight ? "#6d87a7" : "#2a3b57"}"/>${windows}`;
      }).join("");
      return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="${daylight ? "#d8b79b" : "#1b2740"}"/>${celestial}${buildings}</svg>`;
    }
    return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<defs>
  <linearGradient id="sd-lake-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#7fb0dc" : "#1c2b47"}"/>
    <stop offset="65%" stop-color="${daylight ? "#b4d6ee" : "#365078"}"/>
    <stop offset="100%" stop-color="${daylight ? "#e2f0f9" : "#6f8aa9"}"/>
  </linearGradient>
  <radialGradient id="sd-lake-glow"><stop offset="0%" stop-color="${daylight ? "#fff3c4" : "#eef2ff"}" stop-opacity="0.55"/><stop offset="100%" stop-color="${daylight ? "#fff3c4" : "#eef2ff"}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sd-lake-water" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#8dbadd" : "#2d4163"}"/>
    <stop offset="100%" stop-color="${daylight ? "#cfe4f2" : "#4a6384"}"/>
  </linearGradient>
</defs>
<rect width="1600" height="300" fill="url(#sd-lake-sky)"/>
<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="150" fill="url(#sd-lake-glow)"/>
${celestial}
<path d="M120 76 q70 -30 140 -2 q45 -20 96 4" stroke="#ffffff" stroke-width="14" fill="none" opacity="0.16" stroke-linecap="round"/>
<path d="M720 120 q80 -26 160 0 q50 -18 100 4" stroke="#ffffff" stroke-width="10" fill="none" opacity="0.12" stroke-linecap="round"/>
<path d="M0 218 L120 168 L210 200 L330 132 L450 200 L560 158 L690 214 L820 170 L960 218 L1090 166 L1220 210 L1360 158 L1500 204 L1600 176 L1600 250 L0 250 Z" fill="#6f9dc6" opacity="0.28"/>
<path d="M0 238 L120 184 L210 214 L330 146 L450 214 L560 172 L690 228 L820 184 L960 232 L1090 180 L1220 224 L1360 172 L1500 218 L1600 190 L1600 264 L0 264 Z" fill="#3f6f9f" opacity="0.5"/>
<rect y="244" width="1600" height="16" fill="${daylight ? "#e2f0f9" : "#8ba4bf"}" opacity="0.18"/>
<rect x="138" y="152" width="20" height="86" fill="#f5f5f2"/>
<path d="M138 168 h20 M138 198 h20" stroke="#d9544d" stroke-width="8"/>
<path d="M136 152 h24 l-6 -14 h-12 Z" fill="#d9544d"/>
<rect x="143" y="134" width="10" height="8" fill="#ffe9a8"/>
<rect y="258" width="1600" height="42" fill="url(#sd-lake-water)" opacity="0.85"/>
<ellipse cx="${x.toFixed(0)}" cy="276" rx="46" ry="8" fill="${daylight ? "#fff3c4" : "#eef2ff"}" opacity="0.2"/></svg>`;
  }

  private updateBanner(): void {
    if (this.bannerEl) this.bannerEl.innerHTML = this.bannerSvg();
  }

  private updatePomodoroButton(): void {
    const button = this.contentEl.querySelector(".sd-pomodoro-button") as HTMLButtonElement | null;
    if (!button) return;
    const state = this.plugin.pomodoro.state();
    const minutes = String(Math.floor(state.remaining / 60)).padStart(2, "0");
    const seconds = String(state.remaining % 60).padStart(2, "0");
    const mode = state.mode === "focus" ? t("番茄") : state.mode === "short" ? t("短休") : t("长休");
    button.textContent = `${state.running ? "⏸" : "▶"} ${mode} ${minutes}:${seconds}`;
  }

  private cycleArtStyle(): void {
    const styles = ["lake", "ink", "city"] as const;
    const current = this.plugin.store.settings.artStyle;
    this.plugin.store.settings.artStyle = styles[(styles.indexOf(current) + 1) % styles.length];
    void this.plugin.saveSettings();
    this.render();
  }

  private metricLabel(): string {
    const label = METRICS.find((metric) => metric.key === this.metric)?.label;
    return label ? t(label) : this.metric;
  }
}

function startOfWeekFor(date: Date, weekStart: 0 | 1): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const diff = (copy.getDay() - weekStart + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}
