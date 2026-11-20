/** 知识地层页签的渲染逻辑。所有共享状态/方法通过 view 访问。 */
import { MarkdownRenderer, Notice, Platform } from "obsidian";
import { buildWeeklyReview } from "../../../features/review";
import { addDays, dateKey, lastNDays, parseKey } from "../../../utils/dates";
import {
  barChart as barChartSvg,
  mean,
  multiLine as multiLineSvg,
  ring as ringSvg,
  sparkline as sparklineSvg,
  type ChartRef,
} from "../../../utils/charts";
import { METRICS } from "../../../types";
import { t, tf } from "../../../i18n";
import { RANGE_OPTIONS, WEEKDAYS, startOfWeekFor } from "../constants";
import type { DashboardView } from "../../dashboard-view";

export function renderInsights(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  const subnav = body.createDiv({ cls: "sd-subnav" });
  const sections: Array<[typeof view.insightsSection, string]> = [
    ["overview", t("脉冲概览")],
    ["heatmap", t("热力图")],
    ["trend", t("写作趋势")],
    ["folders", t("投入分布")],
    ["yearly", t("年度画像")],
    ["review", t("本周复盘")],
  ];
  for (const [key, label] of sections) {
    // 移动端收窄子导航：投入分布/年度画像为桌面向重图表，窄屏不展示入口。
    if (Platform.isMobile && (key === "folders" || key === "yearly")) continue;
    const button = subnav.createEl("button", {
      cls: key === view.insightsSection ? "is-active" : "",
      text: label,
    });
    button.onclick = () => {
      view.insightsSection = key;
      view.render();
    };
  }

  const content = body.createDiv({ cls: "sd-insight-content" });
  if (view.insightsSection === "overview") {
    renderInsightsSummary(view, content);
    renderOverview(view, content);
  } else if (view.insightsSection === "heatmap") {
    renderHeatmap(view, content, false);
  } else if (view.insightsSection === "trend") {
    renderAnalytics(view, content, "trend");
  } else if (view.insightsSection === "folders") {
    renderAnalytics(view, content, "folders");
    renderAnalytics(view, content, "rhythm");
  } else if (view.insightsSection === "yearly") {
    renderYearly(view, content);
  } else {
    renderReview(view, content);
  }
}

export function renderInsightsSummary(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-insight-summary" });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("本周摘要") });
  head.createEl("button", {
    text: view.insightsExpanded ? t("收起详细图表") : t("展开详细图表"),
  }).onclick = () => {
    view.insightsExpanded = !view.insightsExpanded;
    view.render();
  };
  const store = view.plugin.store;
  const week = lastNDays(7);
  const contribution = week.reduce((sum, key) => sum + store.getDay(key).contribution, 0);
  const words = week.reduce((sum, key) => sum + store.getDay(key).wordsAdded, 0);
  const pending = store.data.memos.filter((memo) => !memo.converted && !memo.archived).length;
  const tasks = store.data.memos.filter((memo) => memo.tags.includes("to-agent") && !memo.converted).length;
  const grid = card.createDiv({ cls: "sd-status-grid" });
  const item = (label: string, value: string): void => {
    const box = grid.createDiv({ cls: "sd-status-item" });
    box.createDiv({ cls: "sd-mini-label", text: label });
    box.createDiv({ cls: "sd-mini-value", text: value });
  };
  item(t("近 7 天贡献"), String(contribution));
  item(t("近 7 天新增词"), String(words));
  item(t("未处理速记"), String(pending));
  item(t("Agent 待办"), String(tasks));
  if (!view.insightsExpanded) {
    card.createDiv({ cls: "sd-card-sub", text: t("详细图表、年度画像与人机热力图已收起，点击右上角展开。") });
  }
}

export function renderOverview(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-overview", attr: { id: "sd-overview" } });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("知识脉冲概览") });
  head.createDiv({ cls: "sd-card-sub", text: `${t("近")} ${t(RANGE_OPTIONS.find((r) => r[0] === view.range)?.[1] ?? "")} · ${t("可靠记录")}` });

  const ranges = card.createDiv({ cls: "sd-ranges" });
  for (const [key, label] of RANGE_OPTIONS) {
    const button = ranges.createEl("button", {
      cls: `sd-range ${key === view.range ? "is-active" : ""}`,
      text: t(label),
    });
    button.onclick = () => {
      view.range = key;
      view.render();
    };
  }

  const keys = view.chartKeys();
  const total = keys.reduce((sum, key) => sum + view.value(key), 0);
  const active = keys.filter((key) => view.value(key) > 0).length;
  const best = keys.reduce(
    (bestDay, day) => (view.value(day) > view.value(bestDay) ? day : bestDay),
    keys[0] ?? dateKey(new Date())
  );
  const grid = card.createDiv({ cls: "sd-overview-grid" });
  const left = grid.createDiv({ cls: "sd-overview-left" });
  left.createDiv({ cls: "sd-metric-label", text: t("累计贡献分") });
  left.createDiv({ cls: "sd-metric-value", text: String(total) });
  left.createDiv({ cls: "sd-metric-hint", text: tf("{active} 天有记录 · 日均 {avg} 分", { active, avg: keys.length ? Math.round(total / keys.length) : 0 }) });
  const overviewValues = keys.map((key) => view.value(key));
  const overviewMean = mean(overviewValues);
  left.innerHTML += sparklineSvg(
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
  mini(t("活跃天数"), `${active} / ${keys.length}`, t("有记录的日子"), ringSvg(active, keys.length));
  mini(t("当前连续"), tf("{n} 天", { n: view.currentStreak() }), tf("最长 {n} 天 · 按全部历史", { n: view.longestStreak() }));
  const investedMinutes = keys.reduce((sum, key) => sum + (view.plugin.store.getDay(key).activeMinutes + view.plugin.store.getDay(key).focusMinutes), 0);
  mini(t("投入时间"), tf("{n} 小时", { n: Math.round(investedMinutes / 60 * 10) / 10 }), t("交互 / 专注"));
  mini(t("最高的一天"), view.value(best) > 0 ? String(view.value(best)) : "—", best);
}

/** 折线图图例（DOM 层：色点 + 文字）。series 未带 label 时不渲染，保持旧调用方外观不变。 */
function renderChartLegend(root: HTMLElement, series: Array<{ color: string; label?: string }>): void {
  const labeled = series.filter((item) => item.label);
  if (labeled.length === 0) return;
  // 读屏信息已由 SVG aria-label 汇总，图例仅供视觉对照，避免重复播报。
  const legend = root.createDiv({ cls: "sd-chart-legend", attr: { "aria-hidden": "true" } });
  for (const item of labeled) {
    const entry = legend.createSpan({ cls: "sd-chart-legend-item" });
    entry.createSpan({ cls: "sd-chart-legend-dot", attr: { style: `background:${item.color}` } });
    entry.createSpan({ text: item.label ?? "" });
  }
}

export function renderHeatmap(view: DashboardView, root: HTMLElement, dual: boolean): void {
  const card = root.createDiv({ cls: "sd-card sd-heatmap", attr: { id: "sd-heatmap" } });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: dual ? t("人机双色热力图") : t("年度知识活跃脉冲") });
  head.createDiv({ cls: "sd-card-sub", text: `${t("近 53 周")} · ${view.metricLabel()}` });

  const metrics = card.createDiv({ cls: "sd-metrics" });
  for (const metric of METRICS) {
    const button = metrics.createEl("button", {
      cls: `sd-metric-tab ${metric.key === view.metric ? "is-active" : ""}`,
      text: t(metric.label),
      attr: { title: t(metric.hint) },
    });
    button.onclick = () => {
      view.metric = metric.key;
      view.plugin.store.settings.heatmapMetric = metric.key;
      void view.plugin.saveSettings();
      view.render();
    };
  }

  const store = view.plugin.store;
  const weekStart = store.settings.weekStart;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = addDays(startOfWeekFor(today, weekStart), -52 * 7);
  const wrap = card.createDiv({ cls: "sd-heatmap-wrap" });
  const grid = wrap.createDiv({ cls: "sd-grid" });
  const labels = grid.createDiv({ cls: "sd-weekdays" });
  for (let row = 0; row < 7; row += 1) {
    const weekday = (row + weekStart) % 7;
    labels.createDiv({ cls: "sd-weekday", text: row % 2 === 0 ? t(WEEKDAYS[weekday]) : "" });
  }
  const main = grid.createDiv({ cls: "sd-main" });
  const months = main.createDiv({ cls: "sd-months" });
  months.style.gridTemplateColumns = "repeat(53, 15px)";
  const columns = main.createDiv({ cls: "sd-columns" });
  const cells: Array<{ key: string; value: number; date: Date; el: HTMLElement; ai: number }> = [];

  for (let week = 0; week < 53; week += 1) {
    const column = columns.createDiv({ cls: "sd-col" });
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(start, week * 7 + day);
      const key = dateKey(date);
      const record = store.getDay(key);
      const cellValue = Number(record[view.metric]) || 0;
      const element = column.createDiv({
        cls: "sd-cell",
        attr: { "data-date": key, role: "gridcell", tabindex: "-1" },
      });
      if (date > today) {
        element.addClass("sd-future");
        element.setAttribute("aria-disabled", "true");
      } else {
        element.setAttribute("aria-label", `${key} · ${view.metricLabel()} ${cellValue}`);
        element.onclick = () => {
          view.hideHeatTooltip();
          view.selected = key;
          view.pendingFocusDate = key;
          view.render();
        };
        element.onmouseenter = (event) => view.showHeatTooltip(event, key);
        element.onmousemove = (event) => view.moveHeatTooltip(event);
        element.onmouseleave = () => view.hideHeatTooltip();
      }
      cells.push({ key, value: cellValue, date, el: element, ai: record.aiWordsAdded });
    }
  }
  for (const cell of cells) {
    if (cell.date.getDate() !== 1) continue;
    const column = Math.floor((cell.date.getTime() - start.getTime()) / (7 * 86400000));
    if (column < 0 || column >= 53) continue;
    const label = months.createDiv({ cls: "sd-month", text: tf("{n}月", { n: cell.date.getMonth() + 1 }) });
    label.style.gridColumn = String(column + 1);
  }
  const max = Math.max(1, ...cells.map((cell) => cell.value));
  for (const cell of cells) {
    const level = cell.value <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((cell.value / max) * 4)));
    cell.el.addClass(`sd-lvl-${level}`);
    if (dual && view.metric === "wordsAdded" && cell.value > 0) {
      const ratio = Math.min(100, (cell.ai / cell.value) * 100);
      cell.el.style.background = `linear-gradient(90deg, var(--interactive-accent) ${ratio}%, var(--text-faint) ${ratio}%)`;
    }
    // 原生 title 已移除：悬停明细由自定义 tooltip 覆盖，读屏走格子 aria-label，避免双重提示。
  }
  const legend = wrap.createDiv({ cls: "sd-legend" });
  legend.createSpan({ text: dual ? t("人") : t("少") });
  for (let level = 0; level <= 4; level += 1) legend.createDiv({ cls: `sd-cell sd-lvl-${level}` });
  legend.createSpan({ text: dual ? t("AI") : t("多") });

  const selectable = cells.filter((cell) => !cell.el.hasClass("sd-future"));
  const focusKey =
    view.selected && selectable.some((cell) => cell.key === view.selected)
      ? view.selected
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
      if (next < 0 || next >= cells.length || cells[next].el.hasClass("sd-future")) return;
      cells[index].el.setAttribute("tabindex", "-1");
      cells[next].el.setAttribute("tabindex", "0");
      cells[next].el.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      view.hideHeatTooltip();
      view.selected = cells[index].key;
      view.pendingFocusDate = cells[index].key;
      view.render();
    }
  });

  if (view.selected) {
    const day = store.getDay(view.selected);
    const detail = card.createDiv({ cls: "sd-day-detail" });
    detail.createDiv({ cls: "sd-day-head", text: view.selected });
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
      item.createDiv({ cls: "sd-detail-label", text: t(label) });
      item.createEl("strong", { text: String(value) });
    }
  }
}

export function renderAnalytics(
  view: DashboardView,
  root: HTMLElement,
  section: "all" | "trend" | "folders" | "rhythm" = "all"
): void {
  const keys = view.chartKeys();
  const days = keys.map((key) => view.plugin.store.getDay(key));
  const label = t(RANGE_OPTIONS.find((range) => range[0] === view.range)?.[1] ?? "");

  if (section === "all" || section === "trend") {
    const trend = view.analyticsCard(root, t("写作与时间趋势"), label);
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
        cls: key === view.trendTab ? "is-active" : "",
        text: title,
      });
      if (button) button.onclick = () => {
        view.trendTab = key;
        view.render();
      };
    }
    const trendContent = trend.createDiv({ cls: "sd-trend-content" });
    if (view.trendTab === "writing") {
      const writingValues = days.map((day) => day.wordsAdded);
      const goal = view.plugin.store.settings.dailyWordGoal || 0;
      const writingMean = mean(writingValues);
      const writingRefs: ChartRef[] = [];
      if (goal > 0) writingRefs.push({ value: goal, label: tf("目标 {n}", { n: goal }), color: "var(--text-accent)" });
      if (writingMean > 0) writingRefs.push({ value: writingMean, label: tf("均值 {n}", { n: Math.round(writingMean) }) });
      trendContent.innerHTML += barChartSvg(writingValues, "var(--interactive-accent)", writingRefs);
    } else if (view.trendTab === "changes") {
      const addedValues = days.map((day) => day.wordsAdded);
      const addedMean = mean(addedValues);
      const changeSeries = [
        { values: addedValues, color: "var(--interactive-accent)", label: t("新增") },
        { values: days.map((day) => day.wordsRemoved), color: "var(--text-faint)", label: t("移除") },
        { values: days.map((day) => day.capturedWords), color: "var(--text-muted)", label: t("捕获") },
      ];
      trendContent.innerHTML += multiLineSvg(
        changeSeries,
        addedMean > 0 ? [{ value: addedMean, label: tf("新增均值 {n}", { n: Math.round(addedMean) }) }] : []
      );
      renderChartLegend(trendContent, changeSeries);
    } else if (view.trendTab === "time") {
      const activeValues = days.map((day) => day.activeMinutes);
      const activeMean = mean(activeValues);
      const timeSeries = [
        { values: activeValues, color: "var(--interactive-accent)", label: t("活跃") },
        { values: days.map((day) => day.focusMinutes), color: "var(--text-faint)", label: t("专注") },
      ];
      trendContent.innerHTML += multiLineSvg(
        timeSeries,
        activeMean > 0 ? [{ value: activeMean, label: tf("活跃均值 {n}", { n: Math.round(activeMean) }) }] : []
      );
      renderChartLegend(trendContent, timeSeries);
    } else {
      const totalWords = days.reduce((sum, day) => sum + day.wordsAdded, 0);
      const captured = days.reduce((sum, day) => sum + day.capturedWords, 0);
      const typed = Math.max(0, totalWords - captured);
      const bar = trendContent.createDiv({ cls: "sd-source-bar" });
      bar.createDiv({ cls: "sd-source-typed" }).style.width = `${totalWords ? (typed / totalWords) * 100 : 0}%`;
      bar.createDiv({ cls: "sd-source-capture" }).style.width = `${totalWords ? (captured / totalWords) * 100 : 0}%`;
      trendContent.createDiv({ cls: "sd-card-sub", text: tf("逐步写入 {typed} 字 · 大段捕获 {captured} 字", { typed, captured }) });
    }
  }

  if (section === "all" || section === "folders") {
    const folders = view.analyticsCard(root, t("投入去向"), t("按目录统计（笔记 × 天）"));
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
      (view.foldersExpanded ? sortedFolders.slice(0, 20) : sortedFolders.slice(0, 6)).entries()) {
      const row = folderList.createDiv({ cls: "sd-folder-row" });
      row.createSpan({ cls: "sd-folder-rank", text: String(index + 1) });
      row.createSpan({ cls: "sd-folder-name", text: folder || "/", attr: { title: folder || "/" } });
      const track = row.createDiv({ cls: "sd-folder-track" });
      const percent = folderWordsTotal > 0 ? (words / folderWordsTotal) * 100 : 0;
      track.createDiv({ cls: "sd-folder-fill" }).style.width = `${percent}%`;
      row.createEl("strong", { text: tf("{words} 字 · {percent}%", { words, percent: percent.toFixed(0) }) });
    }
    if (sortedFolders.length > 6) {
      folders.createEl("button", { text: view.foldersExpanded ? t("收起") : tf("展开其余 {n} 项", { n: sortedFolders.length - 6 }) }).onclick = () => {
        view.foldersExpanded = !view.foldersExpanded;
        view.render();
      };
    }
  }

  if (section === "all" || section === "rhythm") {
    const rhythm = view.analyticsCard(root, t("投入节律矩阵"), t("六项指标按天对齐"));
    const rhythmHead = rhythm.querySelector(".sd-card-head");
    const rhythmTabs = rhythmHead?.createDiv({ cls: "sd-trend-tabs" });
    const rhythmOptions: Array<["matrix" | "hours", string]> = [
      ["matrix", t("节律矩阵")],
      ["hours", t("活跃时段")],
    ];
    for (const [key, title] of rhythmOptions) {
      const button = rhythmTabs?.createEl("button", {
        cls: key === view.rhythmTab ? "is-active" : "",
        text: title,
      });
      if (button) button.onclick = () => {
        view.rhythmTab = key;
        view.render();
      };
    }

    if (view.rhythmTab === "hours") {
      const hourly = Array.from({ length: 24 }, (_, hour) =>
        days.reduce((sum, day) => sum + (day.hourlyWords[hour] ?? 0), 0)
      );
      const hourlyMean = mean(hourly);
      rhythm.createDiv({ cls: "sd-chart-slot" }).innerHTML = barChartSvg(
        hourly,
        "var(--interactive-accent)",
        hourlyMean > 0 ? [{ value: hourlyMean, label: tf("均值 {n}", { n: Math.round(hourlyMean) }) }] : []
      );
      const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
      for (const key of keys) {
        const day = view.plugin.store.getDay(key);
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
        text: view.rhythmActiveOnly ? t("仅活跃日期") : t("全部日期"),
      });
      toggle.onclick = () => {
        view.rhythmActiveOnly = !view.rhythmActiveOnly;
        view.render();
      };
    }
    const grid = rhythm.createDiv({ cls: "sd-rhythm" });
    const metricKeys = ["contribution", "wordsAdded", "activeMinutes", "focusMinutes", "notesCreated", "tasksCompleted"] as const;
    grid.createDiv({ cls: "sd-rhythm-label", text: t("日期") });
    for (const key of metricKeys) grid.createDiv({ cls: "sd-rhythm-label", text: view.shortMetric(key) });
    const maxima = metricKeys.map((key) => Math.max(1, ...days.map((day) => Number(day[key]) || 0)));
    const rhythmKeys = (view.rhythmActiveOnly
      ? keys.filter((key) => view.plugin.store.getDay(key).contribution > 0)
      : keys
    ).slice(-30);
    for (const key of rhythmKeys) {
      const day = view.plugin.store.getDay(key);
      grid.createDiv({ cls: "sd-rhythm-label", text: key.slice(5) });
      metricKeys.forEach((metric, index) => {
        const value = Number(day[metric]) || 0;
        const cell = grid.createDiv({ cls: `sd-rhythm-cell${value > 0 ? "" : " is-empty"}` });
        cell.setAttribute("style", `background:var(--interactive-accent);opacity:${value > 0 ? 0.1 + 0.9 * (value / maxima[index]) : 0.04}`);
      });
    }
  }
}

export function renderYearly(view: DashboardView, root: HTMLElement): void {
  const year = new Date().getFullYear();
  const entries = Object.entries(view.plugin.store.data.days).filter(([key]) => key.startsWith(`${year}-`));
  const card = view.analyticsCard(root, t("年度画像"), tf("{year} 年", { year }));
  card.setAttribute("id", "sd-yearly");
  const yearlyTabs = card.querySelector(".sd-card-head")?.createDiv({ cls: "sd-trend-tabs" });
  const yearlyOptions: Array<["wheel" | "fingerprint" | "moon", string]> = [
    ["wheel", t("年轮")],
    ["fingerprint", t("指纹")],
    ["moon", t("月相")],
  ];
  for (const [key, title] of yearlyOptions) {
    const button = yearlyTabs?.createEl("button", {
      cls: key === view.yearlyTab ? "is-active" : "",
      text: title,
    });
    if (button) button.onclick = () => {
      view.yearlyTab = key;
      view.render();
    };
  }

  if (view.yearlyTab === "wheel") {
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
    card.createDiv({ cls: "sd-chart-slot" }).innerHTML = `<svg viewBox="0 0 220 220" class="sd-wheel">${tracks}${monthTicks}${watermark}${petals}</svg>`;
    return;
  }

  if (view.yearlyTab === "fingerprint") {
    const fingerprintSvg = Array.from({ length: 12 }, (_, month) => {
      const bars = Array.from({ length: 31 }, (_, index) => {
        const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
        const value = view.plugin.store.getDay(key).contribution;
        return `<rect x="${index * 13}" y="${month * 20}" width="9" height="13" rx="2" fill="var(--interactive-accent)" opacity="${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}"/>`;
      }).join("");
      return `<text x="0" y="${month * 20 + 11}" font-size="9" fill="var(--text-faint)">${month + 1}</text>${bars}`;
    }).join("");
    card.createDiv({ cls: "sd-chart-slot" }).innerHTML = `<svg viewBox="0 0 420 248" class="sd-fingerprint">${fingerprintSvg}</svg>`;
    return;
  }

  for (let month = 0; month < 12; month += 1) {
    const section = card.createDiv({ cls: "sd-calendar-month" });
    section.createDiv({ cls: "sd-calendar-title", text: tf("{n} 月", { n: month + 1 }) });
    const grid = section.createDiv({ cls: "sd-calendar-grid" });
    for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day += 1) {
      const date = new Date(year, month, day);
      const value = view.plugin.store.getDay(dateKey(date)).contribution;
      const cell = grid.createDiv({ cls: "sd-calendar-cell", attr: { title: `${dateKey(date)} · ${tf("{n} 分", { n: value })}` } });
      cell.createDiv({ cls: "sd-calendar-moon", text: view.moonGlyph(date) });
      cell.createDiv({ cls: "sd-calendar-value", text: value > 0 ? String(value) : "·" });
    }
  }
}

export function renderReview(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-text-view", attr: { id: "sd-review-card" } });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("知识复盘 · 本周") });
  const markdown = buildWeeklyReview(view.plugin.store, new Date());
  head.createEl("button", { text: t("复制 Markdown") }).onclick = () => {
    void navigator.clipboard.writeText(markdown).then(() => new Notice(t("周复盘已复制")));
  };
  const preview = card.createDiv({ cls: "sd-review-preview" });
  void MarkdownRenderer.render(view.plugin.app, markdown, preview, "", view);
}
