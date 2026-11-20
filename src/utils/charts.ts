/** 纯 SVG 图表生成函数：只依赖入参，无 DOM / 插件状态，便于单测与复用。 */

export type ChartRef = { value: number; label: string; color?: string };

/** 数字参照线：均值/目标等水平虚线，右上角带数值标签。 */
export function referenceLines(
  refs: ChartRef[],
  max: number,
  width: number,
  height: number,
  pad: number
): string {
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

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function barChart(
  values: number[],
  color = "var(--interactive-accent)",
  refs: ChartRef[] = []
): string {
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
  return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}${referenceLines(refs, max, width, height, pad)}</svg>`;
}

export function multiLine(
  series: Array<{ values: number[]; color: string }>,
  refs: ChartRef[] = []
): string {
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
  return `<svg class="sd-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines}${referenceLines(refs, max, width, height, pad)}</svg>`;
}

export function sparkline(values: number[], refs: ChartRef[] = []): string {
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
  return `<svg class="sd-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
<defs><linearGradient id="sd-spark-fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="var(--interactive-accent)" stop-opacity="0.28"/>
<stop offset="100%" stop-color="var(--interactive-accent)" stop-opacity="0"/>
</linearGradient></defs>
<polygon points="${pad},${height - pad} ${points} ${width - pad},${height - pad}" fill="url(#sd-spark-fill)"/>
<polyline points="${points}" fill="none" stroke="var(--interactive-accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
${referenceLines(refs, max, width, height, pad)}${dots}${peakLabel}</svg>`;
}

export function ring(active: number, total: number): string {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? active / total : 0;
  return `<svg viewBox="0 0 68 68" class="sd-ring">
<circle cx="34" cy="34" r="${radius}" fill="none" stroke="var(--background-modifier-border)" stroke-width="7"/>
<circle cx="34" cy="34" r="${radius}" fill="none" stroke="var(--interactive-accent)" stroke-width="7"
  stroke-dasharray="${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 34 34)"/>
<text x="34" y="40" text-anchor="middle" font-size="15" fill="var(--text-normal)">${active}</text></svg>`;
}

export function goalRing(value: number, goal: number): string {
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
