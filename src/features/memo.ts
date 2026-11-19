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

  private async appendToDailyNote(memo: MemoRecord): Promise<void> {
    const vault = this.plugin.app.vault;
    const folder = normalizeFolder(this.store.settings.dailyNoteFolder);
    const fileName = formatDailyNoteName(
      this.store.settings.dailyNoteFormat || "YYYY-MM-DD",
      parseKey(memo.date)
    );
    const path = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

    await ensureFolder(vault, folder);
    const existing = vault.getAbstractFileByPath(path);
    const file: TFile =
      existing instanceof TFile
        ? existing
        : await vault.create(path, `# ${memo.date}\n\n`);

    const content = await vault.read(file);
    const heading = this.store.settings.memoHeading.trim() || "## 速记";
    const tagStr = memo.tags.length
      ? ` ${memo.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`
      : "";
    const callout = `> [!memo] ${memo.time}${tagStr}\n${memo.text
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
}
