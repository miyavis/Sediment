import type { Store } from "../data/store";
import type { MetricKey } from "../types";
import { addDays, dateKey } from "../utils/dates";

function startOfWeek(date: Date, weekStart: 0 | 1): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const diff = (copy.getDay() - weekStart + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

export interface EmbedOptions {
  metric: MetricKey;
  weeks: number;
}

export function parseEmbedOptions(source: string): EmbedOptions {
  const options: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const match = line.match(/^\s*([a-z]+)\s*:\s*(.+)$/i);
    if (match) options[match[1].toLowerCase()] = match[2].trim();
  }
  const metrics: MetricKey[] = [
    "contribution",
    "wordsAdded",
    "edits",
    "notesCreated",
    "tasksCompleted",
    "focusMinutes",
  ];
  const metric = metrics.includes(options.metric as MetricKey)
    ? (options.metric as MetricKey)
    : "contribution";
  const parsedWeeks = Number(options.weeks);
  const weeks = Number.isFinite(parsedWeeks) && parsedWeeks >= 4 && parsedWeeks <= 53
    ? Math.floor(parsedWeeks)
    : 53;
  return { metric, weeks };
}

/** 生成可嵌入 Markdown 的 53 周热力图 SVG。 */
export function heatmapSvg(store: Store, options: EmbedOptions): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = addDays(startOfWeek(today, store.settings.weekStart), -(options.weeks - 1) * 7);
  const size = 13;
  const gap = 3;
  const left = 26;
  const top = 18;
  const width = left + options.weeks * (size + gap);
  const height = top + 7 * (size + gap);

  const cells: Array<{ key: string; x: number; y: number; value: number }> = [];
  let max = 1;
  for (let week = 0; week < options.weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(start, week * 7 + day);
      const value = Number(store.getDay(dateKey(date))[options.metric]) || 0;
      max = Math.max(max, value);
      cells.push({
        key: dateKey(date),
        x: left + week * (size + gap),
        y: top + day * (size + gap),
        value,
      });
    }
  }
  const rects = cells
    .map((cell) => {
      const opacity = cell.value > 0 ? 0.3 + 0.7 * Math.min(1, cell.value / max) : 0.12;
      const fill = cell.value > 0 ? "var(--interactive-accent)" : "var(--background-modifier-border-hover)";
      return `<rect x="${cell.x}" y="${cell.y}" width="${size}" height="${size}" rx="2" fill="${fill}" opacity="${opacity.toFixed(2)}"><title>${cell.key} · ${cell.value}</title></rect>`;
    })
    .join("\n");

  return `<svg viewBox="0 0 ${width} ${height}" class="sd-embed-heatmap" preserveAspectRatio="xMinYMin meet">
${rects}</svg>`;
}

/** 今日快照的紧凑文本，用于 ```sediment-today。 */
export function todayLine(store: Store): string {
  const day = store.getDay(dateKey(new Date()));
  const memos = store.data.memos.filter((memo) => memo.date === dateKey(new Date())).length;
  return `贡献 ${day.contribution} 分 · 新增 ${day.wordsAdded} 字 · 新建 ${day.notesCreated} 篇 · 速记 ${memos} 条`;
}

export interface TodayReportData {
  date: string;
  contribution: number;
  words: number;
  streak: number;
  longest: number;
  memos: number;
  agentCalls: number;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (ctx.measureText(current + char).width > maxWidth && current) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function download(canvas: HTMLCanvasElement, name: string): void {
  const link = document.createElement("a");
  link.download = name;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

/** 把一条速记导出为分享卡片。 */
export function exportMemoCard(
  memo: { date: string; time: string; text: string; tags: string[] },
  template: "minimal" | "ticket" | "ink" = "minimal"
): void {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const palette = {
    minimal: { bg: "#fbfbf9", ink: "#1f2430", accent: "#6f7fa8" },
    ticket: { bg: "#fff8e6", ink: "#4a3b22", accent: "#c08a3e" },
    ink: { bg: "#e9e7e1", ink: "#2c2c2a", accent: "#8c5b52" },
  }[template];
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
  ctx.fillStyle = palette.accent;
  ctx.font = "600 20px sans-serif";
  ctx.fillText("SEDIMENT · 速记", 56, 76);
  ctx.fillStyle = palette.ink;
  ctx.font = "14px sans-serif";
  ctx.fillText(`${memo.date} ${memo.time}`, 56, 108);
  ctx.font = "600 30px sans-serif";
  wrapText(ctx, memo.text, canvas.width - 120).slice(0, 6).forEach((line, index) => {
    ctx.fillText(line, 56, 170 + index * 46);
  });
  if (memo.tags.length > 0) {
    ctx.fillStyle = palette.accent;
    ctx.font = "16px sans-serif";
    ctx.fillText(memo.tags.map((tag) => `#${tag}`).join("  "), 56, canvas.height - 64);
  }
  download(canvas, `sediment-memo-${memo.date}.png`);
}

/** 导出今日战报。 */
export function exportTodayReport(data: TodayReportData): void {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 560;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#f4f7fb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#2f6fb2";
  ctx.fillRect(0, 0, canvas.width, 180);
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 26px sans-serif";
  ctx.fillText("SEDIMENT · 今日战报", 60, 70);
  ctx.font = "18px sans-serif";
  ctx.fillText(data.date, 60, 110);
  ctx.fillStyle = "#20344d";
  ctx.font = "bold 96px sans-serif";
  ctx.fillText(String(data.contribution), 60, 320);
  ctx.font = "20px sans-serif";
  ctx.fillText("贡献分", 60, 356);
  ctx.font = "24px sans-serif";
  const lines = [
    `新增 ${data.words} 字`,
    `连续 ${data.streak} 天 / 最长 ${data.longest} 天`,
    `速记 ${data.memos} 条 · Agent 调用 ${data.agentCalls} 次`,
  ];
  lines.forEach((line, index) => ctx.fillText(line, 60, 420 + index * 40));
  download(canvas, `sediment-today-${data.date}.png`);
}
