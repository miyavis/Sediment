import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { buildWeeklyReview } from "../features/review";
import { METRICS, type MetricKey } from "../types";
import { addDays, dateKey, lastNDays } from "../utils/dates";

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
    banner.innerHTML = `
<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
  <defs>
    <linearGradient id="sd-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f6fb2"/><stop offset="55%" stop-color="#8fc2e8"/><stop offset="100%" stop-color="#d8ecfa"/>
    </linearGradient>
    <linearGradient id="sd-water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7fb3d9"/><stop offset="100%" stop-color="#cfe4f2"/>
    </linearGradient>
    <radialGradient id="sd-sun"><stop offset="0%" stop-color="#fff6cf"/><stop offset="100%" stop-color="#ffd975"/></radialGradient>
  </defs>
  <rect width="1600" height="300" fill="url(#sd-sky)"/>
  <circle cx="1240" cy="86" r="38" fill="url(#sd-sun)" opacity="0.95"/>
  <circle cx="1240" cy="86" r="58" fill="#fff2c4" opacity="0.16"/>
  <path d="M120 70 q60 -26 130 0 q40 -18 90 4" stroke="#ffffff" stroke-width="12" fill="none" opacity="0.18" stroke-linecap="round"/>
  <path d="M760 118 q70 -24 150 0 q50 -16 100 4" stroke="#ffffff" stroke-width="10" fill="none" opacity="0.14" stroke-linecap="round"/>
  <path d="M0 232 L120 178 L210 210 L330 138 L450 208 L560 166 L690 224 L820 180 L960 228 L1090 176 L1220 220 L1360 168 L1500 214 L1600 186 L1600 260 L0 260 Z" fill="#5b8dbd" opacity="0.45"/>
  <path d="M0 252 L160 214 L300 244 L430 200 L580 246 L720 212 L880 250 L1030 208 L1190 246 L1340 206 L1500 244 L1600 220 L1600 280 L0 280 Z" fill="#3f6f9f" opacity="0.5"/>
  <rect x="138" y="150" width="20" height="86" fill="#f5f5f2"/>
  <path d="M138 166 h20 M138 196 h20" stroke="#d9544d" stroke-width="8"/>
  <path d="M136 150 h24 l-6 -14 h-12 Z" fill="#d9544d"/>
  <rect x="143" y="132" width="10" height="8" fill="#ffe9a8"/>
  <rect y="258" width="1600" height="42" fill="url(#sd-water)" opacity="0.75"/>
  <path d="M0 266 h420 M520 266 h300 M900 266 h700" stroke="#ffffff" stroke-width="2" opacity="0.35"/>
</svg>`;

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
    row.createSpan({ text: `写作 ${day.wordsAdded} / 1,000 字` });
    row.createSpan({ text: `连续 ${streak} 天` });
    const progress = card.createDiv({ cls: "sd-progress" });
    const fill = progress.createDiv({ cls: "sd-progress-fill" });
    fill.style.width = `${Math.min(100, (day.wordsAdded / 1000) * 100)}%`;
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
    const values = lastNDays(60).map((key) => this.value(key));
    const max = Math.max(1, ...values);
    const bars = values
      .map((value, index) => {
        const x = 20 + index * 26;
        const height = 10 + (value / max) * 80;
        return `<rect x="${x}" y="${120 - height}" width="16" height="${height}" rx="3" fill="var(--interactive-accent)" opacity="${value > 0 ? 0.75 : 0.15}"/>`;
      })
      .join("");
    const reflection = values
      .map((value, index) => {
        const x = 20 + index * 26;
        const height = 8 + (value / max) * 30;
        return `<rect x="${x}" y="140" width="16" height="${height}" rx="3" fill="var(--interactive-accent)" opacity="${value > 0 ? 0.16 : 0.04}"/>`;
      })
      .join("");
    card.innerHTML = `<div class="sd-card-title">地平线 · 最近 60 天</div>
<svg viewBox="0 0 1600 200" preserveAspectRatio="none" class="sd-horizon-svg">
  <line x1="0" y1="120" x2="1600" y2="120" stroke="var(--background-modifier-border)" stroke-width="1"/>
  ${bars}
  <rect x="0" y="136" width="1600" height="64" fill="var(--background-secondary)" opacity="0.6"/>
  ${reflection}
</svg>`;
  }

  private renderReview(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view" });
    card.createDiv({ cls: "sd-card-title", text: "知识复盘 · 本周" });
    const markdown = buildWeeklyReview(this.plugin.store, new Date());
    card.createEl("pre", { cls: "sd-review-md", text: markdown });
  }

  private renderAnalytics(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view" });
    card.createDiv({ cls: "sd-card-title", text: "数据分析 · 近 30 天新增词数" });
    const keys = lastNDays(30);
    const values = keys.map((key) => Number(this.plugin.store.getDay(key).wordsAdded) || 0);
    card.innerHTML += this.sparkline(values);
    const list = card.createDiv({ cls: "sd-analytics-list" });
    for (const key of keys.slice(-7).reverse()) {
      const row = list.createDiv({ cls: "sd-analytics-row" });
      row.createSpan({ text: key });
      row.createEl("strong", { text: `${this.plugin.store.getDay(key).wordsAdded} 字` });
    }
  }

  private renderYearly(root: HTMLElement): void {
    const card = root.createDiv({ cls: "sd-card sd-text-view" });
    card.createDiv({ cls: "sd-card-title", text: "年度画像 · 月度贡献" });
    const year = new Date().getFullYear();
    const months = card.createDiv({ cls: "sd-year-grid" });
    for (let month = 0; month < 12; month += 1) {
      let total = 0;
      for (const [key, day] of Object.entries(this.plugin.store.data.days)) {
        if (key.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`)) total += day.contribution;
      }
      const item = months.createDiv({ cls: "sd-year-month" });
      item.createDiv({ cls: "sd-year-label", text: `${month + 1}月` });
      item.createDiv({ cls: "sd-year-value", text: String(total) });
    }
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
