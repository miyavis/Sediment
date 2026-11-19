import { Notice, TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import type { MemoRecord } from "../types";
import { dateKey, formatDailyNoteName, hhmm, parseKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

/** flomo 式速记：回车即记，写入当天日记的速记段落。 */
export class MemoManager {
  constructor(private plugin: SedimentPlugin) {}

  private get store() {
    return this.plugin.store;
  }

  async add(
    text: string,
    tags: string[] = [],
    source?: { path: string; line: number }
  ): Promise<MemoRecord | null> {
    const clean = text.trim();
    if (!clean) return null;

    const now = new Date();
    const memo: MemoRecord = {
      id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      date: dateKey(now),
      time: hhmm(now),
      text: clean,
      tags,
      converted: false,
      ...(source ? { sourcePath: source.path, sourceLine: source.line } : {}),
    };

    this.store.addMemo(memo);
    await this.appendToDailyNote(memo);
    new Notice("速记已记录");
    return memo;
  }

  private dailyNotePath(date: string): string {
    const folder = normalizeFolder(this.store.settings.dailyNoteFolder);
    const fileName = formatDailyNoteName(
      this.store.settings.dailyNoteFormat || "YYYY-MM-DD",
      parseKey(date)
    );
    return folder ? `${folder}/${fileName}.md` : `${fileName}.md`;
  }

  private async appendToDailyNote(memo: MemoRecord): Promise<void> {
    const vault = this.plugin.app.vault;
    const folder = normalizeFolder(this.store.settings.dailyNoteFolder);
    const path = this.dailyNotePath(memo.date);

    await ensureFolder(vault, folder);
    const existing = vault.getAbstractFileByPath(path);
    const file: TFile =
      existing instanceof TFile
        ? existing
        : await vault.create(path, `# ${memo.date}\n\n`);

    const content = await vault.read(file);
    const heading = this.store.settings.memoHeading.trim() || "## 速记";
    const callout = `${this.calloutHeader(memo)}\n${memo.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n`;

    const index = content.indexOf(heading);
    let next: string;
    if (index >= 0) {
      const lineEnd = content.indexOf("\n", index);
      const insertAt = lineEnd >= 0 ? lineEnd + 1 : content.length;
      next = `${content.slice(0, insertAt)}\n${callout}${content.slice(insertAt)}`;
    } else {
      next = `${content.trimEnd()}\n\n${heading}\n\n${callout}`;
    }
    await vault.modify(file, next);
  }

  private calloutHeader(memo: MemoRecord): string {
    const tagStr = memo.tags.length
      ? ` ${memo.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`
      : "";
    return `> [!memo] ${memo.time}${tagStr}`;
  }

  /**
   * 在日记文本中定位某条速记的 Callout 行区间 [start, end)。
   * 用「时间 + 正文首行」双重匹配，避免误改同一分钟的另一条速记。
   */
  private findCalloutRange(
    lines: string[],
    memo: MemoRecord,
    textOverride?: string
  ): { start: number; end: number } | null {
    const firstLine = `> ${(textOverride ?? memo.text).split("\n")[0]}`;
    const headerPrefix = `> [!memo] ${memo.time}`;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith(headerPrefix)) continue;
      if (lines[i + 1] !== firstLine) continue;
      let end = i + 1;
      while (end < lines.length && lines[end].startsWith(">")) end += 1;
      return { start: i, end };
    }
    return null;
  }

  /** 把 data.json 里的最新标签同步回日记 Callout（claim/complete/编辑后调用）。 */
  async syncTags(memo: MemoRecord): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.dailyNotePath(memo.date));
    if (!(file instanceof TFile)) return;
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.findCalloutRange(lines, memo);
      if (!range) return data; // 日记可能被手动编辑过，找不到就不动
      lines[range.start] = this.calloutHeader(memo);
      return lines.join("\n");
    });
  }

  /** 重写或删除日记里的 Callout。nextText 为 null 表示删除整块。 */
  private async updateCallout(
    memo: MemoRecord,
    nextText: string | null,
    oldText?: string
  ): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.dailyNotePath(memo.date));
    if (!(file instanceof TFile)) return;
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.findCalloutRange(lines, memo, oldText);
      if (!range) return data;
      if (nextText === null) {
        let start = range.start;
        let end = range.end;
        // 顺带吃掉一个相邻空行，避免删出双空行
        if (lines[start - 1] === "") start -= 1;
        else if (lines[end] === "") end += 1;
        lines.splice(start, end - start);
      } else {
        const body = nextText.split("\n").map((line) => `> ${line}`);
        lines.splice(range.start, range.end - range.start, this.calloutHeader(memo), ...body);
      }
      return lines.join("\n");
    });
  }

  /** 编辑速记正文（可选同时改标签），双写同步日记 Callout。 */
  async edit(id: string, text: string, tags?: string[]): Promise<MemoRecord | null> {
    const memo = this.store.data.memos.find((item) => item.id === id);
    if (!memo) return null;
    const clean = text.trim();
    if (!clean) return null;
    const oldText = memo.text;
    memo.text = clean;
    if (tags) memo.tags = tags.map((tag) => tag.replace(/^#/, "")).filter(Boolean);
    await this.updateCallout(memo, clean, oldText);
    this.store.scheduleSave();
    new Notice("速记已更新");
    return memo;
  }

  /** 删除速记：data.json 与日记 Callout 一起移除。 */
  async remove(id: string): Promise<boolean> {
    const index = this.store.data.memos.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const memo = this.store.data.memos[index];
    await this.updateCallout(memo, null);
    this.store.data.memos.splice(index, 1);
    this.store.scheduleSave();
    new Notice("速记已删除");
    return true;
  }

  /** 归档/取消归档：只影响列表与积压统计，日记里的历史记录保留。 */
  setArchived(id: string, archived: boolean): MemoRecord | null {
    const memo = this.store.data.memos.find((item) => item.id === id);
    if (!memo) return null;
    memo.archived = archived;
    this.store.scheduleSave();
    return memo;
  }
}
