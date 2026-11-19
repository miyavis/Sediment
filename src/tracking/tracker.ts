import { TFile, type Plugin } from "obsidian";
import type { Store } from "../data/store";
import { dateKey } from "../utils/dates";
import { normalizeFolder } from "../utils/vault";

interface FileBaseline {
  words: number;
  tasks: number;
}

/** 中文按字、英文按词计数。 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (
    text.replace(/[\u3400-\u9fff]/g, " ").match(/[A-Za-z0-9_'-]+/g) ?? []
  ).length;
  return cjk + latin;
}

/** 统计已勾选的 markdown 待办数量。 */
export function countCheckedTasks(text: string): number {
  return (text.match(/^\s*[-*+]\s+\[(x|X)\]/gm) ?? []).length;
}

/**
 * 监听 vault 变化，把写作行为折算成当天指标。
 * 这是一个精简实现：不做原插件那种逐行差异指纹，但足以稳定反映新增词、新笔记和任务勾选。
 */
export class Tracker {
  private baseline = new Map<string, FileBaseline>();
  private countedSessions = new Set<string>();
  private ready = false;

  constructor(private plugin: Plugin, private store: Store) {}

  async start(): Promise<void> {
    const vault = this.plugin.app.vault;
    for (const file of vault.getMarkdownFiles()) {
      this.baseline.set(file.path, await this.snapshot(file));
    }

    this.plugin.registerEvent(
      vault.on("create", (file) => {
        if (file instanceof TFile) void this.onCreate(file);
      })
    );
    this.plugin.registerEvent(
      vault.on("modify", (file) => {
        if (file instanceof TFile) void this.onModify(file);
      })
    );
    this.plugin.registerEvent(
      vault.on("delete", (file) => {
        this.baseline.delete(file.path);
      })
    );
    this.plugin.registerEvent(
      vault.on("rename", (file, oldPath) => {
        const snap = this.baseline.get(oldPath);
        if (snap) {
          this.baseline.delete(oldPath);
          this.baseline.set(file.path, snap);
        }
      })
    );

    this.ready = true;
  }

  private async snapshot(file: TFile): Promise<FileBaseline> {
    try {
      const text = await this.plugin.app.vault.cachedRead(file);
      return { words: countWords(text), tasks: countCheckedTasks(text) };
    } catch (error) {
      return { words: 0, tasks: 0 };
    }
  }

  private isExcluded(path: string): boolean {
    const folder = normalizeFolder(this.store.settings.dailyNoteFolder);
    return folder.length > 0 && path.startsWith(`${folder}/`);
  }

  private async onCreate(file: TFile): Promise<void> {
    if (!this.ready || !file.path.endsWith(".md") || this.isExcluded(file.path)) return;
    const snap = await this.snapshot(file);
    this.baseline.set(file.path, snap);
    if (snap.words > 0) {
      this.store.updateDay(this.store.todayKey(), (day) => {
        day.notesCreated += 1;
        day.wordsAdded += snap.words;
      });
      this.markSession(file.path);
    }
  }

  private async onModify(file: TFile): Promise<void> {
    if (!this.ready || !file.path.endsWith(".md") || this.isExcluded(file.path)) return;
    const snap = await this.snapshot(file);
    const prev = this.baseline.get(file.path) ?? { words: 0, tasks: 0 };
    this.baseline.set(file.path, snap);

    const added = Math.max(0, snap.words - prev.words);
    const removed = Math.max(0, prev.words - snap.words);
    const tasks = Math.max(0, snap.tasks - prev.tasks);
    if (added === 0 && removed === 0 && tasks === 0) return;

    this.store.updateDay(this.store.todayKey(), (day) => {
      day.wordsAdded += added;
      day.wordsRemoved += removed;
      day.tasksCompleted += tasks;
    });
    if (added > 0) this.markSession(file.path);
  }

  /** 同一文件同一天最多记一次有效编辑会话，避免连续键入刷分。 */
  private markSession(path: string): void {
    if (!this.store.settings.trackEdits) return;
    const key = `${dateKey(new Date())}|${path}`;
    if (this.countedSessions.has(key)) return;
    this.countedSessions.add(key);
    this.store.updateDay(this.store.todayKey(), (day) => {
      day.edits += 1;
    });
  }
}
