import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { METRICS, type MetricKey } from "../types";
import { addDays, dateKey, startOfWeek } from "../utils/dates";

export const DASHBOARD_VIEW_TYPE = "sediment-dashboard";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** GitHub 风格的知识脉冲看板。 */
export class DashboardView extends ItemView {
  private metric: MetricKey;
  private weeks = 53;
  private selected: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: SedimentPlugin) {
    super(leaf);
    this.metric = plugin.store.settings.heatmapMetric;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sediment";
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  setMetric(metric: MetricKey): void {
    this.metric = metric;
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("kp-dashboard");
    this.renderToolbar(root);
    this.renderSummary(root);
    this.renderHeatmap(root);
    this.renderDetail(root);
  }

  private metricLabel(): string {
    return METRICS.find((metric) => metric.key === this.metric)?.label ?? this.metric;
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "kp-toolbar" });
    bar.createDiv({ cls: "kp-brand", text: "SEDIMENT" });

    const tabs = bar.createDiv({ cls: "kp-tabs" });
    for (const metric of METRICS) {
      const button = tabs.createEl("button", {
        cls: `kp-tab ${metric.key === this.metric ? "is-active" : ""}`,
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

    const select = bar.createEl("select", { cls: "kp-select" });
    for (const count of [7, 13, 26, 53]) {
      const option = select.createEl("option", { text: `近 ${count} 周`, value: String(count) });
      if (count === this.weeks) option.selected = true;
    }
    select.onchange = () => {
      this.weeks = Number(select.value);
      this.render();
    };
  }

  private renderSummary(root: HTMLElement): void {
    const store = this.plugin.store;
    const todayKey = dateKey(new Date());
    const rangeKeys = Array.from(
      { length: this.weeks * 7 },
      (_, i) => dateKey(addDays(new Date(), -(this.weeks * 7 - 1 - i)))
    ).filter((key) => key <= todayKey);
    const value = (key: string): number => Number(store.getDay(key)[this.metric]) || 0;

    const total = rangeKeys.reduce((sum, key) => sum + value(key), 0);
    const active = rangeKeys.filter((key) => value(key) > 0).length;
    const today = value(todayKey);

    let streak = 0;
    let cursor = new Date();
    if (value(dateKey(cursor)) === 0) cursor = addDays(cursor, -1);
    while (value(dateKey(cursor)) > 0 && streak < 400) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }

    const best = rangeKeys.reduce(
      (bestDay, day) => (value(day) > value(bestDay) ? day : bestDay),
      rangeKeys[0] ?? todayKey
    );

    const wrap = root.createDiv({ cls: "kp-summary" });
    const card = (label: string, display: string, hint: string): void => {
      const element = wrap.createDiv({ cls: "kp-card" });
      element.createDiv({ cls: "kp-card-label", text: label });
      element.createDiv({ cls: "kp-card-value", text: display });
      element.createDiv({ cls: "kp-card-hint", text: hint });
    };
    card("区间总量", String(total), `${this.weeks} 周 · ${this.metricLabel()}`);
    card("活跃天数", String(active), "有记录的日子");
    card("当前连续", `${streak} 天`, `截至 ${todayKey}`);
    card("今日", String(today), todayKey);
    card("最高的一天", String(value(best)), best);
  }

  private renderHeatmap(root: HTMLElement): void {
    const store = this.plugin.store;
    const weekStart = store.settings.weekStart;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = addDays(startOfWeek(today, weekStart), -(this.weeks - 1) * 7);

    const wrap = root.createDiv({ cls: "kp-heatmap-wrap" });
    wrap.createDiv({ cls: "kp-section-title", text: `近 ${this.weeks} 周活跃全景` });

    const grid = wrap.createDiv({ cls: "kp-grid" });
    const weekdayLabels = grid.createDiv({ cls: "kp-weekdays" });
    for (let row = 0; row < 7; row++) {
      const weekday = (row + weekStart) % 7;
      weekdayLabels.createDiv({ cls: "kp-weekday", text: row % 2 === 0 ? WEEKDAYS[weekday] : "" });
    }

    const main = grid.createDiv({ cls: "kp-main" });
    const months = main.createDiv({ cls: "kp-months" });
    months.style.gridTemplateColumns = `repeat(${this.weeks}, 15px)`;
    const columns = main.createDiv({ cls: "kp-columns" });

    const cells: Array<{ key: string; value: number; date: Date; el: HTMLElement }> = [];
    for (let week = 0; week < this.weeks; week++) {
      const column = columns.createDiv({ cls: "kp-col" });
      for (let day = 0; day < 7; day++) {
        const date = addDays(start, week * 7 + day);
        const key = dateKey(date);
        const cellValue = Number(store.getDay(key)[this.metric]) || 0;
        const element = column.createDiv({ cls: "kp-cell", attr: { "data-date": key } });
        if (date > today) {
          element.addClass("kp-future");
        } else {
          element.onclick = () => {
            this.selected = key;
            this.render();
          };
        }
        cells.push({ key, value: cellValue, date, el: element });
      }
    }

    // 每月 1 号所在列显示月份。
    for (const cell of cells) {
      if (cell.date.getDate() !== 1) continue;
      const columnIndex = Math.floor((cell.date.getTime() - start.getTime()) / (7 * 86400000));
      if (columnIndex < 0 || columnIndex >= this.weeks) continue;
      const label = months.createDiv({ cls: "kp-month", text: `${cell.date.getMonth() + 1}月` });
      label.style.gridColumn = String(columnIndex + 1);
    }

    const max = Math.max(1, ...cells.map((cell) => cell.value));
    for (const cell of cells) {
      const level =
        cell.value <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((cell.value / max) * 4)));
      cell.el.addClass(`kp-lvl-${level}`);
      cell.el.setAttribute("title", `${cell.key} · ${this.metricLabel()} ${cell.value}`);
    }

    const legend = wrap.createDiv({ cls: "kp-legend" });
    legend.createSpan({ text: "少" });
    for (let level = 0; level <= 4; level++) {
      legend.createDiv({ cls: `kp-cell kp-lvl-${level}` });
    }
    legend.createSpan({ text: "多" });
  }

  private renderDetail(root: HTMLElement): void {
    const box = root.createDiv({ cls: "kp-detail" });
    if (!this.selected) {
      box.createDiv({ cls: "kp-empty", text: "点击热力图中的某一天，查看当天明细。" });
      return;
    }

    const day = this.plugin.store.getDay(this.selected);
    box.createDiv({ cls: "kp-detail-head", text: this.selected });
    const grid = box.createDiv({ cls: "kp-detail-grid" });
    const rows: Array<[string, number]> = [
      ["贡献分", day.contribution],
      ["新增词", day.wordsAdded],
      ["删除词", day.wordsRemoved],
      ["编辑会话", day.edits],
      ["新建笔记", day.notesCreated],
      ["完成任务", day.tasksCompleted],
      ["专注分钟", day.focusMinutes],
    ];
    for (const [label, value] of rows) {
      const item = grid.createDiv({ cls: "kp-detail-item" });
      item.createDiv({ cls: "kp-detail-label", text: label });
      item.createDiv({ cls: "kp-detail-value", text: String(value) });
    }

    const memos = this.plugin.store.data.memos.filter((memo) => memo.date === this.selected);
    if (memos.length > 0) {
      box.createDiv({ cls: "kp-section-title", text: "当天速记" });
      const list = box.createDiv({ cls: "kp-detail-memos" });
      for (const memo of memos) {
        list.createDiv({ cls: "kp-detail-memo", text: `${memo.time} ${memo.text}` });
      }
    }
  }
}
