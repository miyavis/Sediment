import { ItemView, MarkdownRenderer, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { ChangelogModal } from "../ui/changelog-modal";
import { buildWeeklyReview } from "../features/review";
import { METRICS, type MetricKey } from "../types";
import { addDays, dateKey, lastNDays, parseKey } from "../utils/dates";

export const DASHBOARD_VIEW_TYPE = "sediment-dashboard";

type TabKey = "today" | "insights" | "agent";
type RangeKey = "7d" | "30d" | "90d" | "ytd" | "1y";

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
  private selected: string | null = null;
  private posterMonth = new Date().getMonth();
  private bannerEl: HTMLElement | null = null;
  private unsubscribePomodoro: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: SedimentPlugin) {
    super(leaf);
    this.metric = plugin.store.settings.heatmapMetric;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sediment 知识脉冲";
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
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("sd-dashboard");
    this.renderHeader(root);

    if (this.tab === "today") this.renderToday(root);
    else if (this.tab === "insights") this.renderInsights(root);
    else this.renderAgentHub(root);
  }

  private value(key: string): number {
    return Number(this.plugin.store.getDay(key)[this.metric]) || 0;
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
        text: label,
      });
      button.onclick = () => {
        this.tab = key;
        this.render();
      };
    }
    const spacer = bar.createDiv({ cls: "sd-spacer" });
    spacer.setAttribute("style", "flex:1");
    const refresh = bar.createEl("button", { cls: "sd-refresh", text: "刷新" });
    refresh.onclick = () => this.render();
  }

  private renderToday(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
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
    let streak = 0;
    let cursor = new Date();
    if (this.plugin.store.getDay(dateKey(cursor)).contribution === 0) cursor = addDays(cursor, -1);
    while (this.plugin.store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    const card = root.createDiv({ cls: "sd-card sd-today" });
    const head = card.createDiv({ cls: "sd-today-head" });
    head.createDiv({ cls: "sd-today-title", text: "今天" });
    head.createDiv({ cls: "sd-pill", text: day.contribution > 0 ? `${day.contribution} 分` : "还没开始" });
    const row = card.createDiv({ cls: "sd-today-row" });
    const goal = this.plugin.store.settings.dailyWordGoal || 1000;
    row.createSpan({ text: `写作 ${day.wordsAdded} / ${goal.toLocaleString()} 字` });
    row.createSpan({ text: `连续 ${streak} 天` });
    const pomoButton = row.createEl("button", { cls: "sd-pomodoro-button" });
    pomoButton.onclick = () => this.plugin.pomodoro.toggle();
    this.updatePomodoroButton();
    const skip = row.createEl("button", { cls: "sd-pomodoro-skip", text: "跳过" });
    skip.onclick = () => this.plugin.pomodoro.skip();
    const progress = card.createDiv({ cls: "sd-progress" });
    progress.createDiv({ cls: "sd-progress-fill" }).style.width = `${Math.min(100, (day.wordsAdded / goal) * 100)}%`;
  }

  private renderQuickMemo(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-quick-memo" });
    card.createDiv({ cls: "sd-card-title", text: "快速速记" });
    const area = card.createEl("textarea", { cls: "kp-memo-input" });
    area.placeholder = "想到什么，随手记下…";
    area.rows = 2;
    const submit = card.createEl("button", { cls: "mod-cta", text: "记一条" });
    submit.onclick = () => {
      const text = area.value.trim();
      if (!text) return;
      void this.plugin.memos.add(text).then(() => {
        area.value = "";
        this.render();
      });
    };
  }

  private renderTodayAgent(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-agent-feed" });
    card.createDiv({ cls: "sd-card-title", text: "今日 Agent 动态" });
    const today = dateKey(new Date());
    const calls = this.plugin.store.data.toolCalls.filter((call) => call.time.startsWith(today));
    const logs = this.plugin.store.data.workLogs.filter((log) => log.date === today);
    if (calls.length === 0 && logs.length === 0) {
      card.createDiv({ cls: "kp-empty", text: "今天还没有智能体活动。" });
      return;
    }
    const list = card.createDiv({ cls: "sd-analytics-list" });
    for (const call of calls.slice(0, 8)) {
      const row = list.createDiv({ cls: "sd-analytics-row" });
      row.createSpan({ text: `${call.time.slice(11, 16)} · ${call.agent || "unknown"}` });
      row.createEl("strong", { text: call.tool.replace(/^(GET|POST) /, "") });
    }
    for (const log of logs) {
      const row = list.createDiv({ cls: "sd-analytics-row" });
      row.createSpan({ text: `${log.time} · ${log.agent}` });
      row.createEl("strong", { text: log.task });
    }
  }

  private renderInsights(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
    this.renderOverview(body);
    this.renderHeatmap(body, false);
    this.renderHorizon(body);
    this.renderAnalytics(body);
    this.renderYearly(body);
    this.renderReview(body);
    const footer = this.renderFooter(body);
    footer.createEl("button", { text: "月报" }).onclick = () => {
      this.posterMonth = new Date().getMonth();
      this.render();
    };
  }

  private renderAgentHub(root: HTMLElement): void {
    const body = root.createDiv({ cls: "sd-body" });
    this.renderAgentStatus(body);
    this.renderTasksCard(body);
    this.renderHeatmap(body, true);
    this.renderDrafts(body);
    this.renderWorkLogs(body);
    this.renderFooter(body);
  }

  private renderTasksCard(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-tasks" });
    card.createDiv({ cls: "sd-card-title", text: "待办 · 今日 / 遗留 / Agent" });
    const list = card.createDiv({ cls: "sd-task-list" });
    list.createDiv({ cls: "kp-empty", text: "加载中…" });
    void Promise.all([
      this.plugin.tasks.list("today"),
      this.plugin.tasks.list("overdue"),
      this.plugin.tasks.list("agent"),
    ]).then(([today, overdue, agent]) => {
      list.empty();
      const items = [...today.filter((task) => !task.checked), ...overdue, ...agent];
      if (items.length === 0) {
        list.createDiv({ cls: "kp-empty", text: "没有未完成待办。" });
        return;
      }
      for (const task of items.slice(0, 12)) {
        const row = list.createDiv({ cls: "sd-task-item" });
        const button = row.createEl("button", {
          cls: "sd-task-open",
          text: task.text,
          attr: { title: task.path || "Agent 任务" },
        });
        if (task.path) button.onclick = () => void this.plugin.app.workspace.openLinkText(task.path, "", false);
        else if (task.sourcePath)
          button.onclick = () => void this.openTaskSource(task.sourcePath, task.sourceLine);
        row.createDiv({
          cls: "sd-task-meta",
          text: task.path
            ? `${task.date} · ${task.path.split("/").pop()}:${task.line}`
            : task.sourcePath
              ? `Agent · 原待办 ${task.sourcePath.split("/").pop()}:${task.sourceLine ?? 1}`
              : `Agent · ${task.date}`,
        });
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
    card.createDiv({ cls: "sd-card-title", text: "连接与调用状态" });
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
    item("本地 API", settings.agentServerEnabled ? `在线 · ${settings.agentServerPort}` : "未启用");
    item("累计调用", String(calls.length));
    for (const [agent, count] of Object.entries(byAgent)) item(agent, `${count} 次`);
    const last = calls[0];
    if (last) card.createDiv({ cls: "sd-card-sub", text: `最近调用：${last.time.slice(0, 16)} · ${last.tool}` });
  }

  private renderDrafts(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: "AI 沉淀审核" });
    const drafts: TFile[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.sediment_status === "draft") drafts.push(file);
    }
    if (drafts.length === 0) {
      card.createDiv({ cls: "kp-empty", text: "没有待审核的 AI 草稿。" });
      return;
    }
    const list = card.createDiv({ cls: "sd-draft-list" });
    for (const file of drafts.slice(0, 20)) {
      const item = list.createDiv({ cls: "sd-draft-card" });
      const title = item.createEl("button", { cls: "sd-draft-title", text: file.basename });
      title.onclick = () => void this.plugin.app.workspace.openLinkText(file.path, "", false);
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const category = String(cache?.frontmatter?.category ?? "未分类");
      item.createDiv({ cls: "sd-card-sub", text: `${category} · ${file.path}` });
      const actions = item.createDiv({ cls: "sd-draft-actions" });
      actions.createEl("button", { text: "采纳并归档" }).onclick = () => {
        void this.plugin.agentApi.updateFrontmatter(file.path, { sediment_status: "accepted" }).then(() => {
          new Notice("已采纳");
          this.render();
        });
      };
      actions.createEl("button", { text: "合并到关联笔记" }).onclick = () => void this.mergeDraft(file);
      actions.createEl("button", { text: "驳回删除" }).onclick = () => {
        void this.plugin.app.vault.trash(file, false).then(() => {
          new Notice("已驳回并移入回收站");
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
      new Notice("这张草稿没有关联笔记，无法合并");
      return;
    }
    const target = this.plugin.app.vault
      .getMarkdownFiles()
      .find((item) => item.basename === first || item.path === first);
    if (!target) {
      new Notice(`找不到关联笔记：${first}`);
      return;
    }
    const source = await this.plugin.app.vault.read(file);
    const body = source.replace(/^---[\s\S]*?---\s*/, "");
    await this.plugin.app.vault.process(target, (data) => `${data.trimEnd()}\n\n${body.trim()}\n`);
    await this.plugin.app.vault.trash(file, false);
    new Notice(`已合并到 ${target.basename}`);
    this.render();
  }

  private renderWorkLogs(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card" });
    card.createDiv({ cls: "sd-card-title", text: "智能体工作日志" });
    const logs = this.plugin.store.data.workLogs.slice(0, 10);
    if (logs.length === 0) {
      card.createDiv({ cls: "kp-empty", text: "还没有工作日志。" });
      return;
    }
    const list = card.createDiv({ cls: "sd-analytics-list" });
    for (const log of logs) {
      const row = list.createDiv({ cls: "sd-analytics-row" });
      row.createSpan({ text: `${log.date} ${log.time} · ${log.agent}` });
      row.createEl("strong", { text: log.task });
    }
  }

  private renderFooter(root: HTMLElement): HTMLElement {
    const footer = root.createDiv({ cls: "sd-footer" });
    footer.createSpan({ text: `Sediment ${this.plugin.manifest.version} · 数据只留在本地` });
    const changelog = footer.createEl("button", { text: "更新记录" });
    changelog.onclick = () => new ChangelogModal(this.plugin.app).open();
    const styleButton = footer.createEl("button", { text: "换画风" });
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

  private barChart(values: number[], color = "var(--interactive-accent)"): string {
    const width = 900;
    const height = 120;
    const pad = 4;
    const max = Math.max(1, ...values);
    const barWidth = (width - pad * 2) / Math.max(1, values.length);
    const rects = values
      .map((value, index) => {
        const h = (value / max) * (height - pad * 2);
        return `<rect x="${(pad + index * barWidth).toFixed(1)}" y="${(height - pad - h).toFixed(1)}" width="${(barWidth * 0.72).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${value > 0 ? 0.8 : 0.12}"/>`;
      })
      .join("");
    return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}</svg>`;
  }

  private multiLine(series: Array<{ values: number[]; color: string }>): string {
    const width = 900;
    const height = 140;
    const pad = 6;
    const max = Math.max(1, ...series.flatMap((item) => item.values));
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
    return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines}</svg>`;
  }

  private renderOverview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-overview" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: "知识脉冲概览" });
    head.createDiv({ cls: "sd-card-sub", text: `近 ${RANGE_OPTIONS.find((r) => r[0] === this.range)?.[1] ?? ""} · 可靠记录` });

    const ranges = card.createDiv({ cls: "sd-ranges" });
    for (const [key, label] of RANGE_OPTIONS) {
      const button = ranges.createEl("button", {
        cls: `sd-range ${key === this.range ? "is-active" : ""}`,
        text: label,
      });
      button.onclick = () => {
        this.range = key;
        this.render();
      };
    }

    const keys = this.rangeKeys();
    const total = keys.reduce((sum, key) => sum + this.value(key), 0);
    const active = keys.filter((key) => this.value(key) > 0).length;
    const best = keys.reduce(
      (bestDay, day) => (this.value(day) > this.value(bestDay) ? day : bestDay),
      keys[0] ?? dateKey(new Date())
    );
    const grid = card.createDiv({ cls: "sd-overview-grid" });
    const left = grid.createDiv({ cls: "sd-overview-left" });
    left.createDiv({ cls: "sd-metric-label", text: "累计贡献分" });
    left.createDiv({ cls: "sd-metric-value", text: String(total) });
    left.createDiv({ cls: "sd-metric-hint", text: `${active} 天有记录 · 日均 ${keys.length ? Math.round(total / keys.length) : 0} 分` });
    left.innerHTML += this.sparkline(keys.map((key) => this.value(key)));

    const right = grid.createDiv({ cls: "sd-overview-right" });
    const mini = (label: string, value: string, hint: string, ring?: string): void => {
      const item = right.createDiv({ cls: "sd-mini" });
      item.createDiv({ cls: "sd-mini-label", text: label });
      item.createDiv({ cls: "sd-mini-value", text: value });
      item.createDiv({ cls: "sd-mini-hint", text: hint });
      if (ring) item.createDiv({ cls: "sd-mini-ring" }).innerHTML = ring;
    };
    mini("活跃天数", `${active} / ${keys.length}`, "有记录的日子", this.ring(active, keys.length));
    mini("当前连续", "0 天", "最长 0 天 · 按全部历史");
    mini("投入时间", "0 小时", "交互 / 专注");
    mini("最高的一天", this.value(best) > 0 ? String(this.value(best)) : "—", best);
  }

  private sparkline(values: number[]): string {
    const width = 620;
    const height = 96;
    const pad = 6;
    const max = Math.max(1, ...values);
    const points = values
      .map((value, index) => {
        const x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
        const y = height - pad - (value / max) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<svg class="sd-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
<polyline points="${points}" fill="none" stroke="var(--interactive-accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
<polygon points="${pad},${height - pad} ${points} ${width - pad},${height - pad}" fill="var(--interactive-accent)" opacity="0.1"/></svg>`;
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

  private renderHeatmap(root: HTMLElement, dual: boolean): void {
    const card = root.createDiv({ cls: "sd-card sd-heatmap" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: dual ? "人机双色热力图" : "年度知识活跃脉冲" });
    head.createDiv({ cls: "sd-card-sub", text: `近 53 周 · ${this.metricLabel()}` });

    const metrics = card.createDiv({ cls: "sd-metrics" });
    for (const metric of METRICS) {
      const button = metrics.createEl("button", {
        cls: `sd-metric-tab ${metric.key === this.metric ? "is-active" : ""}`,
        text: metric.label,
        attr: { title: metric.hint },
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
        const element = column.createDiv({ cls: "kp-cell", attr: { "data-date": key } });
        if (date > today) element.addClass("kp-future");
        else
          element.onclick = () => {
            this.selected = key;
            this.render();
          };
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
    legend.createSpan({ text: dual ? "人" : "少" });
    for (let level = 0; level <= 4; level += 1) legend.createDiv({ cls: `kp-cell kp-lvl-${level}` });
    legend.createSpan({ text: dual ? "AI" : "多" });

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
        item.createDiv({ cls: "kp-detail-label", text: label });
        item.createEl("strong", { text: String(value) });
      }
    }
  }

  private renderHorizon(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-horizon" });
    card.createDiv({ cls: "sd-card-title", text: "地平线 · 最近 60 天" });
    const values = lastNDays(60).map((key) => this.value(key));
    const max = Math.max(1, ...values);
    const step = 1600 / values.length;
    const ridge = values
      .map((value, index) => `${(index * step).toFixed(1)},${(190 - (value / max) * 110).toFixed(1)}`)
      .join(" ");
    const reflectionPoints = values
      .map((value, index) => `${(index * step).toFixed(1)},${(208 + (value / max) * 52).toFixed(1)}`)
      .join(" ");
    const stones = values
      .map((value, index) =>
        value > 0
          ? `<circle cx="${(index * step + step / 2).toFixed(1)}" cy="${(188 - (value / max) * 110).toFixed(1)}" r="2.6" fill="var(--interactive-accent)" opacity="0.8"/>`
          : ""
      )
      .join("");
    const hour = new Date().getHours();
    const daylight = hour >= 6 && hour < 18;
    const x = 180 + (hour / 24) * 1240;
    const celestial = daylight
      ? `<circle cx="${x.toFixed(0)}" cy="74" r="28" fill="#ffe08a"/>`
      : `<circle cx="${x.toFixed(0)}" cy="74" r="24" fill="#f2f0dc"/>`;
    const sailing = this.plugin.pomodoro.state().running
      ? `<g transform="translate(1280 232)"><path d="M0 18 h54 l-8 12 H8 Z" fill="var(--text-muted)"/><path d="M26 16 V-26 l24 34 Z" fill="var(--interactive-accent)"/></g>`
      : "";
    card.innerHTML += `<svg viewBox="0 0 1600 300" preserveAspectRatio="none" class="sd-horizon-svg">
<rect width="1600" height="200" fill="${daylight ? "#cfe2f2" : "#33455f"}" opacity="0.6"/>
${celestial}
<polygon points="0,200 ${ridge} 1600,200" fill="var(--interactive-accent)" opacity="0.28"/>
${stones}
<rect y="200" width="1600" height="100" fill="var(--background-secondary)" opacity="0.75"/>
<polygon points="0,206 ${reflectionPoints} 1600,206" fill="var(--interactive-accent)" opacity="0.12"/>
${sailing}
</svg>`;
  }

  private renderAnalytics(root: HTMLElement): void {
    const keys = this.rangeKeys();
    const days = keys.map((key) => this.plugin.store.getDay(key));
    const label = RANGE_OPTIONS.find((range) => range[0] === this.range)?.[1] ?? "";

    const writing = this.analyticsCard(root, "每日写作", label);
    writing.innerHTML += this.barChart(days.map((day) => day.wordsAdded));
    const changes = this.analyticsCard(root, "写作变化", "新增 / 删除 / 大段捕获");
    changes.innerHTML += this.multiLine([
      { values: days.map((day) => day.wordsAdded), color: "var(--interactive-accent)" },
      { values: days.map((day) => day.wordsRemoved), color: "var(--text-faint)" },
      { values: days.map((day) => day.capturedWords), color: "var(--text-muted)" },
    ]);
    const time = this.analyticsCard(root, "时间投入", "交互活跃 / 专注");
    time.innerHTML += this.multiLine([
      { values: days.map((day) => day.activeMinutes), color: "var(--interactive-accent)" },
      { values: days.map((day) => day.focusMinutes), color: "var(--text-faint)" },
    ]);

    const totalWords = days.reduce((sum, day) => sum + day.wordsAdded, 0);
    const captured = days.reduce((sum, day) => sum + day.capturedWords, 0);
    const source = this.analyticsCard(root, "写作来源", "逐步写入 / 大段捕获");
    const typed = Math.max(0, totalWords - captured);
    const bar = source.createDiv({ cls: "sd-source-bar" });
    bar.createDiv({ cls: "sd-source-typed" }).style.width = `${totalWords ? (typed / totalWords) * 100 : 0}%`;
    bar.createDiv({ cls: "sd-source-capture" }).style.width = `${totalWords ? (captured / totalWords) * 100 : 0}%`;
    source.createDiv({ cls: "sd-card-sub", text: `逐步写入 ${typed} 字 · 大段捕获 ${captured} 字` });

    const folders = this.analyticsCard(root, "投入去向", "按目录统计（笔记 × 天）");
    const folderTotals = new Map<string, number>();
    for (const day of days) {
      for (const [folder, words] of Object.entries(day.folderWords)) {
        folderTotals.set(folder, (folderTotals.get(folder) ?? 0) + words);
      }
    }
    const folderList = folders.createDiv({ cls: "sd-analytics-list" });
    for (const [folder, words] of [...folderTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const row = folderList.createDiv({ cls: "sd-analytics-row" });
      row.createSpan({ text: folder || "/" });
      row.createEl("strong", { text: `${words} 字` });
    }

    const hourly = Array.from({ length: 24 }, (_, hour) =>
      days.reduce((sum, day) => sum + (day.hourlyWords[hour] ?? 0), 0)
    );
    const hours = this.analyticsCard(root, "活跃时段", "按小时的新增词数");
    hours.innerHTML += this.barChart(hourly);
    const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const key of keys) {
      const day = this.plugin.store.getDay(key);
      const weekday = parseKey(key).getDay();
      for (let hour = 0; hour < 24; hour += 1) weekdayHour[weekday][hour] += day.hourlyWords[hour] ?? 0;
    }
    const hourMax = Math.max(1, ...weekdayHour.flat());
    const pattern = hours.createDiv({ cls: "sd-hour-grid" });
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = pattern.createDiv({ cls: "sd-hour-cell" });
        const ratio = weekdayHour[weekday][hour] / hourMax;
        cell.setAttribute("style", `background:var(--interactive-accent);opacity:${ratio > 0 ? 0.1 + ratio * 0.9 : 0.05}`);
      }
    }

    const rhythm = this.analyticsCard(root, "投入节律矩阵", "六项指标按天对齐");
    const grid = rhythm.createDiv({ cls: "sd-rhythm" });
    const metricKeys = ["contribution", "wordsAdded", "activeMinutes", "focusMinutes", "notesCreated", "tasksCompleted"] as const;
    grid.createDiv({ cls: "sd-rhythm-label", text: "日期" });
    for (const key of metricKeys) grid.createDiv({ cls: "sd-rhythm-label", text: this.shortMetric(key) });
    const maxima = metricKeys.map((key) => Math.max(1, ...days.map((day) => Number(day[key]) || 0)));
    for (const key of keys.slice(-30)) {
      const day = this.plugin.store.getDay(key);
      grid.createDiv({ cls: "sd-rhythm-label", text: key.slice(5) });
      metricKeys.forEach((metric, index) => {
        const value = Number(day[metric]) || 0;
        const cell = grid.createDiv({ cls: "sd-rhythm-cell" });
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
    return names[key] ?? key;
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
    const wheel = this.analyticsCard(root, "年轮", `${year} 年 · 每天一片花瓣`);
    const petals = entries
      .map(([key, day]) => {
        const dayOfYear = Math.floor((parseKey(key).getTime() - new Date(year, 0, 0).getTime()) / 86400000);
        const angle = (dayOfYear / 365) * Math.PI * 2 - Math.PI / 2;
        const length = 10 + Math.min(64, day.contribution * 3);
        const x1 = 110 + Math.cos(angle) * 36;
        const y1 = 110 + Math.sin(angle) * 36;
        const x2 = 110 + Math.cos(angle) * (36 + length);
        const y2 = 110 + Math.sin(angle) * (36 + length);
        const color = day.contribution > 0 ? "var(--interactive-accent)" : "var(--background-modifier-border)";
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
      })
      .join("");
    wheel.innerHTML += `<svg viewBox="0 0 220 220" class="sd-wheel">${petals}</svg>`;

    const fingerprint = this.analyticsCard(root, "知识指纹", "每天一根色条");
    const fingerprintSvg = Array.from({ length: 12 }, (_, month) => {
      const bars = Array.from({ length: 31 }, (_, index) => {
        const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
        const value = this.plugin.store.getDay(key).contribution;
        return `<rect x="${index * 13}" y="${month * 20}" width="9" height="13" rx="2" fill="var(--interactive-accent)" opacity="${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}"/>`;
      }).join("");
      return `<text x="0" y="${month * 20 + 11}" font-size="9" fill="var(--text-faint)">${month + 1}</text>${bars}`;
    }).join("");
    fingerprint.innerHTML += `<svg viewBox="0 0 420 248" class="sd-fingerprint">${fingerprintSvg}</svg>`;

    const calendar = this.analyticsCard(root, "月相日历", "满月是高峰日，新月是休息日");
    for (let month = 0; month < 12; month += 1) {
      const section = calendar.createDiv({ cls: "sd-calendar-month" });
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

    const poster = this.analyticsCard(root, "月报海报", "点左右箭头切换月份");
    const posterHead = poster.createDiv({ cls: "sd-poster-head" });
    const prev = posterHead.createEl("button", { text: "‹" });
    const title = posterHead.createDiv({ cls: "sd-poster-title", text: `${year} 年 ${this.posterMonth + 1} 月` });
    const next = posterHead.createEl("button", { text: "›" });
    prev.onclick = () => {
      this.posterMonth = (this.posterMonth + 11) % 12;
      this.render();
    };
    next.onclick = () => {
      this.posterMonth = (this.posterMonth + 1) % 12;
      this.render();
    };
    const post = poster.createDiv({ cls: "sd-poster" });
    const prefix = `${year}-${String(this.posterMonth + 1).padStart(2, "0")}`;
    const monthDays = entries.filter(([key]) => key.startsWith(prefix));
    const monthTotal = monthDays.reduce((sum, [, day]) => sum + day.contribution, 0);
    const monthWords = monthDays.reduce((sum, [, day]) => sum + day.wordsAdded, 0);
    const monthActive = monthDays.filter(([, day]) => day.contribution > 0).length;
    post.createDiv({ cls: "sd-poster-big", text: String(monthTotal) });
    post.createDiv({ cls: "sd-poster-sub", text: "本月贡献分" });
    const stats = post.createDiv({ cls: "sd-poster-stats" });
    stats.createSpan({ text: `活跃 ${monthActive} 天` });
    stats.createSpan({ text: `新增 ${monthWords} 字` });
    const grid = post.createDiv({ cls: "sd-poster-grid" });
    for (let day = 1; day <= new Date(year, this.posterMonth + 1, 0).getDate(); day += 1) {
      const value = this.plugin.store.getDay(`${prefix}-${String(day).padStart(2, "0")}`).contribution;
      grid.createDiv({ cls: "sd-poster-cell", attr: { title: `${prefix}-${String(day).padStart(2, "0")} · ${value} 分` } }).setAttribute(
        "style",
        `background:var(--interactive-accent);opacity:${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}`
      );
    }
    poster.createEl("button", { cls: "sd-poster-export", text: "导出 PNG" }).onclick = () =>
      void this.exportPoster(title.textContent, monthTotal, monthWords, monthActive);
  }

  private async exportPoster(title: string, total: number, words: number, active: number): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f4f7fb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#2f6fb2";
    ctx.fillRect(0, 0, canvas.width, 260);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px sans-serif";
    ctx.fillText(title, 60, 130);
    ctx.fillStyle = "#20344d";
    ctx.font = "bold 120px sans-serif";
    ctx.fillText(String(total), 60, 470);
    ctx.font = "32px sans-serif";
    ctx.fillText(`活跃 ${active} 天 · 新增 ${words} 字`, 60, 610);
    const link = document.createElement("a");
    link.download = `sediment-${title.replace(/\s/g, "")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  private renderReview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: "知识复盘 · 本周" });
    const markdown = buildWeeklyReview(this.plugin.store, new Date());
    head.createEl("button", { text: "复制 Markdown" }).onclick = () => {
      void navigator.clipboard.writeText(markdown).then(() => new Notice("周复盘已复制"));
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
    const mode = state.mode === "focus" ? "番茄" : state.mode === "short" ? "短休" : "长休";
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
    return METRICS.find((metric) => metric.key === this.metric)?.label ?? this.metric;
  }
}

function startOfWeekFor(date: Date, weekStart: 0 | 1): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const diff = (copy.getDay() - weekStart + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}
