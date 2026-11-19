import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { buildWeeklyReview } from "../features/review";
import { METRICS, type MetricKey } from "../types";
import { addDays, dateKey, lastNDays, parseKey } from "../utils/dates";

export const DASHBOARD_VIEW_TYPE = "sediment-dashboard";

type RangeKey = "7d" | "30d" | "90d" | "ytd" | "1y";
type TabKey = "board" | "review" | "analytics" | "yearly";

const RANGE_OPTIONS: Array<[RangeKey, string]> = [
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
  ["90d", "近 90 天"],
  ["ytd", "今年"],
  ["1y", "近一年"],
];

const TABS: Array<[TabKey, string]> = [
  ["board", "看板视图"],
  ["review", "知识复盘"],
  ["analytics", "数据分析"],
  ["yearly", "年度画像"],
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 与 Crisp Pulse 同构的完整主视图：横幅 + 今天 + 概览 + 热力图 + 地平线。 */
export class DashboardView extends ItemView {
  private metric: MetricKey = "contribution";
  private range: RangeKey = "1y";
  private tab: TabKey = "board";
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
    this.renderToday(root);

    const body = root.createDiv({ cls: "sd-body" });
    if (this.tab === "board") {
      this.renderOverview(body);
      this.renderHeatmap(body);
      this.renderHorizon(body);
      const footer = body.createDiv({ cls: "sd-footer" });
      footer.createSpan({ text: `Sediment ${this.plugin.manifest.version} · 数据只留在本地` });
      const monthly = footer.createEl("button", { text: "月报" });
      monthly.onclick = () => {
        this.tab = "yearly";
        this.render();
      };
      const styleButton = footer.createEl("button", { text: "换画风" });
      styleButton.onclick = () => this.cycleArtStyle();
    } else if (this.tab === "review") {
      this.renderReview(body);
    } else if (this.tab === "analytics") {
      this.renderAnalytics(body);
    } else {
      this.renderYearly(body);
    }
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
    const today = dateKey(new Date());
    const day = this.plugin.store.getDay(today);
    let streak = 0;
    let cursor = new Date();
    if (this.plugin.store.getDay(dateKey(cursor)).contribution === 0) {
      cursor = addDays(cursor, -1);
    }
    while (this.plugin.store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }

    const card = root.createDiv({ cls: "sd-card sd-today" });
    const head = card.createDiv({ cls: "sd-today-head" });
    head.createDiv({ cls: "sd-today-title", text: "今天" });
    head.createDiv({
      cls: "sd-pill",
      text: day.contribution > 0 ? `${day.contribution} 分` : "还没开始",
    });
    const row = card.createDiv({ cls: "sd-today-row" });
    const goal = this.plugin.store.settings.dailyWordGoal || 1000;
    row.createSpan({ text: `写作 ${day.wordsAdded} / ${goal.toLocaleString()} 字` });
    row.createSpan({ text: `连续 ${streak} 天` });
    const pomoButton = row.createEl("button", { cls: "sd-pomodoro-button" });
    pomoButton.onclick = () => this.plugin.pomodoro.toggle();
    this.updatePomodoroButton();
    const skipButton = row.createEl("button", { cls: "sd-pomodoro-skip", text: "跳过" });
    skipButton.onclick = () => this.plugin.pomodoro.skip();
    const progress = card.createDiv({ cls: "sd-progress" });
    const fill = progress.createDiv({ cls: "sd-progress-fill" });
    fill.style.width = `${Math.min(100, (day.wordsAdded / goal) * 100)}%`;
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
    const best = keys.reduce((bestDay, day) => (this.value(day) > this.value(bestDay) ? day : bestDay), keys[0] ?? dateKey(new Date()));

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
      if (ring) {
        const holder = item.createDiv({ cls: "sd-mini-ring" });
        holder.innerHTML = ring;
      }
    };
    mini("活跃天数", `${active} / ${keys.length}`, "这段时间有记录的日子", this.ring(active, keys.length));
    mini("当前连续", "0 天", "最长 0 天 · 按全部历史");
    mini("投入时间", "0 小时", "交互 / 专注（待联动）");
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
    const area = `${pad},${height - pad} ${points} ${width - pad},${height - pad}`;
    return `<svg class="sd-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
<polyline points="${points}" fill="none" stroke="var(--interactive-accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
<polygon points="${area}" fill="var(--interactive-accent)" opacity="0.1"/></svg>`;
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

  private renderHeatmap(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-heatmap" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: "年度知识活跃脉冲" });
    head.createDiv({ cls: "sd-card-sub", text: `近 53 周 · ${this.metricLabel()} ${this.plugin.store.getDay(dateKey(new Date()))[this.metric] ?? 0} 分` });

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
    const cells: Array<{ key: string; value: number; date: Date; el: HTMLElement }> = [];

    for (let week = 0; week < 53; week += 1) {
      const column = columns.createDiv({ cls: "kp-col" });
      for (let day = 0; day < 7; day += 1) {
        const date = addDays(start, week * 7 + day);
        const key = dateKey(date);
        const element = column.createDiv({ cls: "kp-cell", attr: { "data-date": key } });
        if (date > today) {
          element.addClass("kp-future");
        } else {
          element.onclick = () => {
            this.selected = key;
            this.render();
          };
        }
        cells.push({ key, value: this.value(key), date, el: element });
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
      cell.el.setAttribute("title", `${cell.key} · ${this.metricLabel()} ${cell.value}`);
    }
    const legend = wrap.createDiv({ cls: "kp-legend" });
    legend.createSpan({ text: "少" });
    for (let level = 0; level <= 4; level += 1) legend.createDiv({ cls: `kp-cell kp-lvl-${level}` });
    legend.createSpan({ text: "多" });

    if (this.selected) {
      const day = store.getDay(this.selected);
      const detail = card.createDiv({ cls: "sd-day-detail" });
      detail.createDiv({ cls: "sd-day-head", text: this.selected });
      const rows: Array<[string, number]> = [
        ["贡献分", day.contribution],
        ["新增词", day.wordsAdded],
        ["编辑会话", day.edits],
        ["新建笔记", day.notesCreated],
        ["完成任务", day.tasksCompleted],
      ];
      for (const [label, value] of rows) {
        const item = detail.createDiv({ cls: "sd-day-item" });
        item.createSpan({ text: label });
        item.createEl("strong", { text: String(value) });
      }
    }
  }

  private renderHorizon(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-horizon" });
    card.createDiv({ cls: "sd-card-title", text: "地平线 · 最近 60 天" });
    card.createDiv({
      cls: "sd-card-sub",
      text: "山脊是每天的贡献分，最右边的小旗是今天；湖面倒映着天空，专注时会有帆船。",
    });

    const values = lastNDays(60).map((key) => this.value(key));
    const max = Math.max(1, ...values);
    const step = 1600 / values.length;
    const ridge = values
      .map((value, index) => `${(index * step).toFixed(1)},${(190 - (value / max) * 110).toFixed(1)}`)
      .join(" ");
    const mountains = `0,200 ${ridge} 1600,200`;
    const reflectionPoints = values
      .map((value, index) => `${(index * step).toFixed(1)},${(208 + (value / max) * 52).toFixed(1)}`)
      .join(" ");
    const reflection = `0,206 ${reflectionPoints} 1600,206`;
    const stones = values
      .map((value, index) =>
        value > 0
          ? `<circle cx="${(index * step + step / 2).toFixed(1)}" cy="${(188 - (value / max) * 110).toFixed(1)}" r="2.6" fill="var(--interactive-accent)" opacity="0.8"/>`
          : ""
      )
      .join("");

    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const daylight = hour >= 6 && hour < 18;
    const x = 180 + (hour / 24) * 1240;
    const celestial = daylight
      ? `<circle cx="${x.toFixed(0)}" cy="74" r="28" fill="#ffe08a"/><circle cx="${x.toFixed(0)}" cy="74" r="46" fill="#fff3c4" opacity="0.16"/>`
      : `<circle cx="${x.toFixed(0)}" cy="74" r="24" fill="#f2f0dc" opacity="0.9"/><text x="${x.toFixed(0)}" y="84" font-size="24" text-anchor="middle">${this.moonGlyph(now)}</text>`;

    const month = now.getMonth();
    const treeColor =
      month === 11 || month < 3 ? "#d7e4ec" : month < 6 ? "#8fbf7a" : month < 9 ? "#6fa05f" : "#d59a5b";
    const trees = [140, 380, 650, 940, 1230]
      .map((tx) => `<path d="M${tx} 190 l14 -34 l14 34 Z" fill="${treeColor}" opacity="0.7"/>`)
      .join("");

    const sailing = this.plugin.pomodoro.state().running
      ? `<g transform="translate(1280 232)"><path d="M0 18 h54 l-8 12 H8 Z" fill="var(--text-muted)"/><path d="M26 16 V-26 l24 34 Z" fill="var(--interactive-accent)" opacity="0.75"/></g>`
      : "";

    card.innerHTML += `<svg viewBox="0 0 1600 300" preserveAspectRatio="none" class="sd-horizon-svg">
<defs>
  <linearGradient id="sd-hsky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#9fc8e8" : "#2b3f60"}"/>
    <stop offset="100%" stop-color="${daylight ? "#e6f2fa" : "#64809f"}"/>
  </linearGradient>
</defs>
<rect width="1600" height="200" fill="url(#sd-hsky)"/>
${celestial}
<polygon points="${mountains}" fill="var(--interactive-accent)" opacity="0.28"/>
<polygon points="${mountains}" fill="none" stroke="var(--interactive-accent)" stroke-width="2" opacity="0.6"/>
${stones}
${trees}
<rect x="1560" y="118" width="3" height="76" fill="var(--text-muted)"/>
<path d="M1563 120 l34 10 -34 10 Z" fill="var(--interactive-accent)"/>
<rect y="200" width="1600" height="100" fill="var(--background-secondary)" opacity="0.75"/>
<polygon points="${reflection}" fill="var(--interactive-accent)" opacity="0.12"/>
<ellipse cx="${x.toFixed(0)}" cy="232" rx="38" ry="9" fill="${daylight ? "#ffe08a" : "#f2f0dc"}" opacity="0.22"/>
${sailing}
</svg>`;
  }

  private renderReview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: "知识复盘 · 本周" });
    const markdown = buildWeeklyReview(this.plugin.store, new Date());
    const copy = head.createEl("button", { text: "复制 Markdown" });
    copy.onclick = () => {
      void navigator.clipboard.writeText(markdown).then(() => new Notice("周复盘已复制"));
    };
    const preview = card.createDiv({ cls: "sd-review-preview" });
    void MarkdownRenderer.render(this.plugin.app, markdown, preview, "", this);
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
    const typed = Math.max(0, totalWords - captured);
    const sources = this.analyticsCard(root, "写作来源", "逐步写入 / 大段捕获");
    const sourceBar = sources.createDiv({ cls: "sd-source-bar" });
    const typedPart = sourceBar.createDiv({ cls: "sd-source-typed" });
    typedPart.style.width = `${totalWords ? (typed / totalWords) * 100 : 0}%`;
    const capturePart = sourceBar.createDiv({ cls: "sd-source-capture" });
    capturePart.style.width = `${totalWords ? (captured / totalWords) * 100 : 0}%`;
    sources.createDiv({
      cls: "sd-card-sub",
      text: `逐步写入 ${typed} 字 · 大段捕获 ${captured} 字`,
    });

    const folderTotals = new Map<string, number>();
    for (const day of days) {
      for (const [folder, words] of Object.entries(day.folderWords)) {
        folderTotals.set(folder, (folderTotals.get(folder) ?? 0) + words);
      }
    }
    const folders = this.analyticsCard(root, "投入去向", "按目录统计（笔记 × 天）");
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
    hours.innerHTML += this.barChart(hourly, "var(--interactive-accent)");

    const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const key of keys) {
      const day = this.plugin.store.getDay(key);
      const weekday = parseKey(key).getDay();
      for (let hour = 0; hour < 24; hour += 1) {
        weekdayHour[weekday][hour] += day.hourlyWords[hour] ?? 0;
      }
    }
    const hourMax = Math.max(1, ...weekdayHour.flat());
    const pattern = hours.createDiv({ cls: "sd-hour-grid" });
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = pattern.createDiv({ cls: "sd-hour-cell" });
        const ratio = weekdayHour[weekday][hour] / hourMax;
        cell.setAttribute("style", `background:var(--interactive-accent);opacity:${ratio > 0 ? 0.1 + ratio * 0.9 : 0.05}`);
        cell.setAttribute("title", `${weekday} 周 · ${hour} 时 · ${weekdayHour[weekday][hour]} 字`);
      }
    }

    const rhythm = this.analyticsCard(root, "投入节律矩阵", "六项指标按天对齐，颜色为区间内相对高低");
    const grid = rhythm.createDiv({ cls: "sd-rhythm" });
    const metricKeys = [
      "contribution",
      "wordsAdded",
      "activeMinutes",
      "focusMinutes",
      "notesCreated",
      "tasksCompleted",
    ] as const;
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
        cell.setAttribute("title", `${key} · ${this.shortMetric(metric)} ${value}`);
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

    const wheel = this.analyticsCard(root, "年轮", `${year} 年 · 每天一片花瓣，长度是贡献`);
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
        const opacity = value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06;
        return `<rect x="${index * 13}" y="${month * 20}" width="9" height="13" rx="2" fill="var(--interactive-accent)" opacity="${opacity.toFixed(2)}"/>`;
      }).join("");
      return `<text x="0" y="${month * 20 + 11}" font-size="9" fill="var(--text-faint)">${month + 1}</text>${bars}`;
    }).join("");
    fingerprint.innerHTML += `<svg viewBox="0 0 420 248" class="sd-fingerprint">${fingerprintSvg}</svg>`;

    const calendar = this.analyticsCard(root, "月相日历", "满月是高峰日，新月是休息日");
    for (let month = 0; month < 12; month += 1) {
      const section = calendar.createDiv({ cls: "sd-calendar-month" });
      section.createDiv({ cls: "sd-calendar-title", text: `${month + 1} 月` });
      const grid = section.createDiv({ cls: "sd-calendar-grid" });
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month, day);
        const value = this.plugin.store.getDay(dateKey(date)).contribution;
        const cell = grid.createDiv({ cls: "sd-calendar-cell" });
        cell.setAttribute("title", `${dateKey(date)} · ${value} 分`);
        cell.createDiv({ cls: "sd-calendar-moon", text: this.moonGlyph(date) });
        cell.createDiv({ cls: "sd-calendar-value", text: value > 0 ? String(value) : "·" });
      }
    }

    const strata = this.analyticsCard(root, "知识地层", "每周一层，按目录分色");
    const layerGrid = strata.createDiv({ cls: "sd-strata" });
    for (let week = 0; week < 26; week += 1) {
      const row = layerGrid.createDiv({ cls: "sd-strata-row" });
      const start = addDays(new Date(year, 0, 1), week * 7);
      const folders = new Map<string, number>();
      for (let offset = 0; offset < 7; offset += 1) {
        const day = this.plugin.store.getDay(dateKey(addDays(start, offset)));
        for (const [folder, words] of Object.entries(day.folderWords)) {
          folders.set(folder, (folders.get(folder) ?? 0) + words);
        }
      }
      row.createDiv({ cls: "sd-strata-label", text: `${start.getMonth() + 1}/${start.getDate()}` });
      const total = [...folders.values()].reduce((sum, value) => sum + value, 0) || 1;
      for (const [folder, words] of [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        const segment = row.createDiv({ cls: "sd-strata-segment" });
        segment.style.width = `${(words / total) * 100}%`;
        segment.setAttribute("title", `${folder} · ${words} 字`);
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
    const monthPrefix = `${year}-${String(this.posterMonth + 1).padStart(2, "0")}`;
    const monthDays = entries.filter(([key]) => key.startsWith(monthPrefix));
    const monthTotal = monthDays.reduce((sum, [, day]) => sum + day.contribution, 0);
    const monthWords = monthDays.reduce((sum, [, day]) => sum + day.wordsAdded, 0);
    const monthActive = monthDays.filter(([, day]) => day.contribution > 0).length;
    post.createDiv({ cls: "sd-poster-big", text: String(monthTotal) });
    post.createDiv({ cls: "sd-poster-sub", text: "本月贡献分" });
    const stats = post.createDiv({ cls: "sd-poster-stats" });
    stats.createSpan({ text: `活跃 ${monthActive} 天` });
    stats.createSpan({ text: `新增 ${monthWords} 字` });
    const posterGrid = post.createDiv({ cls: "sd-poster-grid" });
    for (let day = 1; day <= new Date(year, this.posterMonth + 1, 0).getDate(); day += 1) {
      const key = `${monthPrefix}-${String(day).padStart(2, "0")}`;
      const value = this.plugin.store.getDay(key).contribution;
      const cell = posterGrid.createDiv({ cls: "sd-poster-cell" });
      cell.setAttribute("style", `background:var(--interactive-accent);opacity:${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}`);
      cell.setAttribute("title", `${key} · ${value} 分`);
    }
    const exportButton = poster.createEl("button", { cls: "sd-poster-export", text: "导出 PNG" });
    exportButton.onclick = () => void this.exportPoster(title.textContent, monthTotal, monthWords, monthActive);
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
    ctx.font = "36px sans-serif";
    ctx.fillText("本月贡献分", 60, 530);
    ctx.font = "32px sans-serif";
    ctx.fillText(`活跃 ${active} 天 · 新增 ${words} 字`, 60, 610);
    const link = document.createElement("a");
    link.download = `sediment-${title.replace(/\s/g, "")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  private bannerSvg(): string {
    const style = this.plugin.store.settings.artStyle;
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const daylight = hour >= 6 && hour < 18;
    const x = 180 + (hour / 24) * 1240;
    const y = Math.max(34, 60 - Math.sin(((hour - 6) / 12) * Math.PI) * 34);
    const celestial = daylight
      ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="34" fill="#ffe08a"/><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="56" fill="#fff3c4" opacity="0.18"/>`
      : `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="30" fill="#f2f0dc" opacity="0.9"/><text x="${x.toFixed(0)}" y="${(y + 10).toFixed(0)}" font-size="30" text-anchor="middle">${this.moonGlyph(now)}</text>`;

    if (style === "ink") {
      return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="#e9e7e1"/>
<path d="M0 150 q300 -90 560 10 q260 -120 520 -20 q260 -70 520 30 L1600 300 L0 300 Z" fill="#9aa0a3" opacity="0.5"/>
<path d="M0 210 q240 -70 480 10 q300 -90 560 -10 q260 -50 560 20 L1600 300 L0 300 Z" fill="#5f676c" opacity="0.6"/>
<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="38" fill="#f7f5ee" stroke="#8b9094" stroke-width="2"/>
<rect x="1460" y="40" width="62" height="62" fill="#b6473f" opacity="0.85"/>
<text x="1491" y="82" font-size="30" text-anchor="middle" fill="#fff">沉</text>
</svg>`;
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
<rect width="1600" height="300" fill="${daylight ? "#d8b79b" : "#1b2740"}"/>
${celestial}
${buildings}
<rect y="282" width="1600" height="18" fill="${daylight ? "#93adc5" : "#101a2e"}"/>
</svg>`;
    }
    return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="url(#sd-sky)"/>
<defs>
  <linearGradient id="sd-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#2f6fb2" : "#15294a"}"/>
    <stop offset="60%" stop-color="${daylight ? "#8fc2e8" : "#3d5b86"}"/>
    <stop offset="100%" stop-color="${daylight ? "#d8ecfa" : "#7793b6"}"/>
  </linearGradient>
</defs>
${celestial}
<path d="M120 70 q60 -26 130 0 q40 -18 90 4" stroke="#ffffff" stroke-width="12" fill="none" opacity="0.16" stroke-linecap="round"/>
<path d="M0 232 L120 178 L210 210 L330 138 L450 208 L560 166 L690 224 L820 180 L960 228 L1090 176 L1220 220 L1360 168 L1500 214 L1600 186 L1600 260 L0 260 Z" fill="#5b8dbd" opacity="0.45"/>
<path d="M0 252 L160 214 L300 244 L430 200 L580 246 L720 212 L880 250 L1030 208 L1190 246 L1340 206 L1500 244 L1600 220 L1600 280 L0 280 Z" fill="#3f6f9f" opacity="0.5"/>
<rect x="138" y="150" width="20" height="86" fill="#f5f5f2"/>
<path d="M138 166 h20 M138 196 h20" stroke="#d9544d" stroke-width="8"/>
<path d="M136 150 h24 l-6 -14 h-12 Z" fill="#d9544d"/>
<rect x="143" y="132" width="10" height="8" fill="#ffe9a8"/>
<rect y="258" width="1600" height="42" fill="${daylight ? "#a9cbe4" : "#2b3f5e"}" opacity="0.75"/>
</svg>`;
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
