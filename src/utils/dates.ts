/** 纯本地日期工具，不依赖任何第三方库。 */

export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function startOfWeek(d: Date, weekStart: 0 | 1): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const diff = (r.getDay() - weekStart + 7) % 7;
  r.setDate(r.getDate() - diff);
  return r;
}

export function endOfWeek(d: Date, weekStart: 0 | 1): Date {
  return addDays(startOfWeek(d, weekStart), 6);
}

/** 返回 [start, end] 之间每一天的 key（含两端，从早到晚）。 */
export function eachDay(start: Date, end: Date): string[] {
  const out: string[] = [];
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(0, 0, 0, 0);
  for (let d = s; d <= e; d = addDays(d, 1)) out.push(dateKey(d));
  return out;
}

/** 最近 n 天的 key，从早到晚。 */
export function lastNDays(n: number, end: Date = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => dateKey(addDays(end, -(n - 1 - i))));
}

/** 把 YYYY / MM / DD 占位符替换成实际日期。 */
export function formatDailyNoteName(format: string, d: Date): string {
  return format
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, String(d.getMonth() + 1).padStart(2, "0"))
    .replace(/DD/g, String(d.getDate()).padStart(2, "0"));
}

export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
