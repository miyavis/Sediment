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
 * 笔记归属日期：优先 frontmatter 的 created / date（YYYY-MM-DD），
 * 回退文件创建时间。导入的旧笔记也能归到正确的日子。
 */
export function noteDateKey(text: string, fallback: Date): string {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    const field = frontmatter[1].match(/^(?:created|date)\s*:\s*["']?(\d{4}-\d{2}-\d{2})/m);
    if (field) {
      const [y, m, d] = field[1].split("-").map(Number);
      const parsed = new Date(y, m - 1, d);
      if (parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d) {
        return field[1];
      }
    }
  }
  return dateKey(fallback);
}

/** Agent 写入抑制窗口：写入后这段时间内的 vault 事件不计入人类统计。 */
const AGENT_WRITE_WINDOW_MS = 10_000;

/**
 * 监听 vault 变化，把写作行为折算成当天指标。
 * 这是一个精简实现：不做原插件那种逐行差异指纹，但足以稳定反映新增词、新笔记和任务勾选。
 * Agent 经 API 写入的内容只计 aiWordsAdded，不重复计入人类指标。
 */
export class Tracker {
  private baseline = new Map<string, FileBaseline>();
  private countedSessions = new Set<string>();
  private activeBuckets = new Set<string>();
  private agentWrites = new Map<string, number>();
  private startedAt = Date.now();
  private ready = false;

  constructor(private plugin: Plugin, private store: Store) {}

  async start(): Promise<void> {
    const vault = this.plugin.app.vault;
    for (const file of vault.getMarkdownFiles()) {
      this.baseline.set(file.path, await this.snapshot(file));
    }

    // 恢复今天已计过的编辑会话，重启 Obsidian 不重复计分。
    const today = this.store.todayKey();
    for (const path of this.store.data.editSessions[today] ?? []) {
      this.countedSessions.add(`${today}|${path}`);
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
        const agentAt = this.agentWrites.get(oldPath);
        if (agentAt !== undefined) {
          this.agentWrites.delete(oldPath);
          this.agentWrites.set(file.path, agentAt);
        }
      })
    );

    this.ready = true;
  }

  /** Agent API 写入前调用：标记来源，随后触发的 vault 事件不计入人类统计。 */
  markAgentWrite(path: string): void {
    const now = Date.now();
    this.agentWrites.set(path, now);
    for (const [key, at] of this.agentWrites) {
      if (now - at > AGENT_WRITE_WINDOW_MS * 6) this.agentWrites.delete(key);
    }
  }

  private isAgentWrite(path: string): boolean {
    const at = this.agentWrites.get(path);
    return at !== undefined && Date.now() - at <= AGENT_WRITE_WINDOW_MS;
  }

  private async snapshot(file: TFile): Promise<FileBaseline> {
    try {
      const text = await this.plugin.app.vault.cachedRead(file);
      return { words: countWords(text), tasks: countCheckedTasks(text) };
    } catch (error) {
      return { words: 0, tasks: 0 };
    }
  }

  /** 插件自身产出的目录（日记/复盘/工作日志/备份）不计入人类写作统计。 */
  private isExcluded(path: string): boolean {
    const settings = this.store.settings;
    const folders = [
      settings.dailyNoteFolder,
      settings.reviewFolder,
      settings.workLogFolder,
      settings.backupFolder,
    ]
      .map(normalizeFolder)
      .filter((folder) => folder.length > 0);
    return folders.some((folder) => path.startsWith(`${folder}/`));
  }

  /** 单次写入计入的词数上限，防大段粘贴刷分；0 表示不封顶。 */
  private capWords(words: number): number {
    const cap = this.store.settings.wordsPerWriteCap ?? 0;
    return cap > 0 ? Math.min(words, cap) : words;
  }

  private async onCreate(file: TFile): Promise<void> {
    if (!this.ready || !file.path.endsWith(".md") || this.isExcluded(file.path)) return;
    // Obsidian 启动时会为已有文件补发 create 事件，不能当成"新建笔记"统计。
    if (file.stat.ctime < this.startedAt - 60_000) return;
    let text = "";
    try {
      text = await this.plugin.app.vault.cachedRead(file);
    } catch (error) {
      // 读不到就按空文件处理
    }
    const snap = { words: countWords(text), tasks: countCheckedTasks(text) };
    this.baseline.set(file.path, snap);
    // Agent 新建的笔记只计 aiWordsAdded（由 API 侧记录），这里只更新基线。
    if (this.isAgentWrite(file.path)) return;
    if (snap.words > 0) {
      const hour = new Date().getHours();
      const folder = file.parent?.path ?? "/";
      const dayKey = noteDateKey(text, new Date(file.stat.ctime));
      const words = this.capWords(snap.words);
      this.store.updateDay(dayKey, (day) => {
        day.notesCreated += 1;
        day.wordsAdded += words;
        day.capturedWords += words;
        day.hourlyWords[hour] = (day.hourlyWords[hour] ?? 0) + words;
        day.folderWords[folder] = (day.folderWords[folder] ?? 0) + words;
      });
      this.markSession(file.path);
      this.markActive();
    }
  }

  private async onModify(file: TFile): Promise<void> {
    if (!this.ready || !file.path.endsWith(".md") || this.isExcluded(file.path)) return;
    const snap = await this.snapshot(file);
    const prev = this.baseline.get(file.path) ?? { words: 0, tasks: 0 };
    // 无论是否计入统计都要更新基线，否则 Agent 写入的词会在下次人类编辑时被误计。
    this.baseline.set(file.path, snap);
    if (this.isAgentWrite(file.path)) return;

    const added = Math.max(0, snap.words - prev.words);
    const removed = Math.max(0, prev.words - snap.words);
    const tasks = Math.max(0, snap.tasks - prev.tasks);
    if (added === 0 && removed === 0 && tasks === 0) return;

    const hour = new Date().getHours();
    const folder = file.parent?.path ?? "/";
    const counted = this.capWords(added);
    const captured = counted >= 200 ? counted : 0;
    this.store.updateDay(this.store.todayKey(), (day) => {
      day.wordsAdded += counted;
      day.wordsRemoved += removed;
      day.tasksCompleted += tasks;
      day.capturedWords += captured;
      day.hourlyWords[hour] = (day.hourlyWords[hour] ?? 0) + counted;
      day.folderWords[folder] = (day.folderWords[folder] ?? 0) + counted;
    });
    if (added > 0) this.markSession(file.path);
    this.markActive();
  }

  /** 按 5 分钟桶估算交互活跃时间。 */
  private markActive(): void {
    const now = new Date();
    const bucket = `${dateKey(now)}|${now.getHours()}:${Math.floor(now.getMinutes() / 5)}`;
    if (this.activeBuckets.has(bucket)) return;
    this.activeBuckets.add(bucket);
    this.store.updateDay(this.store.todayKey(), (day) => {
      day.activeMinutes += 5;
    });
  }

  /** 同一文件同一天最多记一次有效编辑会话，避免连续键入刷分；去重表持久化。 */
  private markSession(path: string): void {
    if (!this.store.settings.trackEdits) return;
    const today = dateKey(new Date());
    const key = `${today}|${path}`;
    if (this.countedSessions.has(key)) return;
    this.countedSessions.add(key);
    const list = this.store.data.editSessions[today] ?? [];
    if (!list.includes(path)) {
      list.push(path);
      this.store.data.editSessions[today] = list;
    }
    this.store.updateDay(this.store.todayKey(), (day) => {
      day.edits += 1;
    });
  }
}