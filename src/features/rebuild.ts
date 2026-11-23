import type { Vault } from "obsidian";
import type { Store } from "../data/store";
import { countWords, noteDateKey } from "../tracker";
import { isPathInFolders, pluginOwnedFolders } from "../utils/vault";

export interface RebuildResult {
  scanned: number;
  filledDays: number;
  notes: number;
  words: number;
}

/**
 * 全库历史重建：按 frontmatter created/date（回退 ctime）把存量笔记归到对应日期，
 * 只补齐「没有任何记录」的空日期，不覆盖已有统计，避免抹掉编辑会话等过程数据。
 * Agent 写入的笔记（frontmatter source: agent）与插件自身产出目录不计入。
 */
export async function rebuildHistory(store: Store, vault: Vault): Promise<RebuildResult> {
  const settings = store.settings;
  const excluded = pluginOwnedFolders(settings);

  const byDate = new Map<string, { notes: number; words: number }>();
  let scanned = 0;
  for (const file of vault.getMarkdownFiles()) {
    if (isPathInFolders(file.path, excluded)) continue;
    let text = "";
    try {
      text = await vault.cachedRead(file);
    } catch {
      continue;
    }
    if (/^source\s*:\s*agent\b/m.test(text.slice(0, 800))) continue;
    const words = countWords(text);
    if (words === 0) continue;
    scanned += 1;
    const key = noteDateKey(text, new Date(file.stat.ctime));
    const bucket = byDate.get(key) ?? { notes: 0, words: 0 };
    bucket.notes += 1;
    bucket.words += words;
    byDate.set(key, bucket);
  }

  let filledDays = 0;
  let notes = 0;
  let words = 0;
  for (const [key, bucket] of byDate) {
    const existing = store.data.days[key];
    const isEmpty =
      !existing ||
      (existing.wordsAdded === 0 &&
        existing.notesCreated === 0 &&
        existing.edits === 0 &&
        existing.tasksCompleted === 0 &&
        existing.focusMinutes === 0);
    if (!isEmpty) continue;
    store.updateDay(key, (day) => {
      day.notesCreated = bucket.notes;
      day.wordsAdded = bucket.words;
    });
    filledDays += 1;
    notes += bucket.notes;
    words += bucket.words;
  }
  store.recomputeContributions();
  return { scanned, filledDays, notes, words };
}