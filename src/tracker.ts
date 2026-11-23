import { TFile, type Plugin } from "obsidian";
import type { Store } from "./data/store";
import { dateKey } from "./utils/dates";
import { isPathInFolders, pluginOwnedFolders } from "./utils/vault";

interface FileBaseline {
  words: number;
  tasks: number;
}

/** 可注入时钟：测试用假时钟驱动去抖与 Agent 抑制窗口。 */
export interface TrackerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const defaultClock: TrackerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

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
 * 抑制期内的待结算状态：人类基线冻结，Agent 写入事件到达时记录 Agent 快照，
 * 窗口结束后按「最终内容 − Agent 快照」的实际 diff 补计人的编辑。
 */
interface PendingAgentWrite {
  /** Agent 事件尚未到达时使用的兜底基线（冻结的人类基线）。 */
  frozen: FileBaseline | undefined;
  /** Agent 自身写入事件对应的快照；窗口内人类编辑相对它计 diff。 */
  agentSnap: FileBaseline | null;
  /** 是否仍在等待 Agent 写入本身触发的 vault 事件。 */
  expectEvent: boolean;
  endsAt: number;
  timer: number;
}

/**
 * 监听 vault 变化，把写作行为折算成当天指标。
 * 这是一个精简实现：不做原插件那种逐行差异指纹，但足以稳定反映新增词、新笔记和任务勾选。
 * Agent 经 API 写入的内容只计 aiWordsAdded，不重复计入人类指标；
 * 抑制期内人的编辑不会被吞——基线暂缓更新，窗口结束按实际 diff 补计。
 */
export class Tracker {
  private baseline = new Map<string, FileBaseline>();
  private countedSessions = new Set<string>();
  private activeBuckets = new Set<string>();
  private agentWrites = new Map<string, number>();
  private pendingAgent = new Map<string, PendingAgentWrite>();
  private modifyTimers = new Map<string, number>();
  private startedAt: number;
  private ready = false;

  constructor(
    private plugin: Plugin,
    private store: Store,
    private clock: TrackerClock = defaultClock
  ) {
    this.startedAt = this.clock.now();
  }

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
        if (file instanceof TFile) this.scheduleModify(file);
      })
    );
    this.plugin.registerEvent(
      vault.on("delete", (file) => {
        this.baseline.delete(file.path);
        const timer = this.modifyTimers.get(file.path);
        if (timer !== undefined) this.clock.clearTimeout(timer);
        this.modifyTimers.delete(file.path);
        this.clearPendingAgent(file.path);
      })
    );
    this.plugin.registerEvent(
      vault.on("rename", (file, oldPath) => {
        const snap = this.baseline.get(oldPath);
        if (snap) {
          this.baseline.delete(oldPath);
          this.baseline.set(file.path, snap);
        }
        const timer = this.modifyTimers.get(oldPath);
        if (timer !== undefined) {
          this.clock.clearTimeout(timer);
          this.modifyTimers.delete(oldPath);
        }
        const agentAt = this.agentWrites.get(oldPath);
        if (agentAt !== undefined) {
          this.agentWrites.delete(oldPath);
          this.agentWrites.set(file.path, agentAt);
        }
        const pending = this.pendingAgent.get(oldPath);
        if (pending) {
          this.pendingAgent.delete(oldPath);
          this.clock.clearTimeout(pending.timer);
          const remaining = Math.max(0, pending.endsAt - this.clock.now());
          pending.timer = this.clock.setTimeout(() => void this.settleAgentWindow(file.path), remaining);
          this.pendingAgent.set(file.path, pending);
        }
      })
    );

    this.ready = true;
  }

  /** 停用插件时清理未执行的去抖修改任务与待结算的 Agent 窗口。 */
  stop(): void {
    for (const timer of this.modifyTimers.values()) this.clock.clearTimeout(timer);
    this.modifyTimers.clear();
    for (const path of [...this.pendingAgent.keys()]) this.clearPendingAgent(path);
  }

  private clearPendingAgent(path: string): void {
    const pending = this.pendingAgent.get(path);
    if (!pending) return;
    this.clock.clearTimeout(pending.timer);
    this.pendingAgent.delete(path);
    this.agentWrites.delete(path);
  }

  private scheduleModify(file: TFile): void {
    const previous = this.modifyTimers.get(file.path);
    if (previous !== undefined) this.clock.clearTimeout(previous);
    const timer = this.clock.setTimeout(() => {
      this.modifyTimers.delete(file.path);
      void this.onModify(file);
    }, 120);
    this.modifyTimers.set(file.path, timer);
  }

  /** Agent API 写入前调用：标记来源，随后触发的 vault 事件不计入人类统计。 */
  markAgentWrite(path: string): void {
    const now = this.clock.now();
    this.agentWrites.set(path, now);
    for (const [key, at] of this.agentWrites) {
      if (now - at > AGENT_WRITE_WINDOW_MS * 6) this.agentWrites.delete(key);
    }
    const existing = this.pendingAgent.get(path);
    if (existing) {
      // 窗口内又一次 Agent 写入：重新等待它的写入事件并顺延窗口。
      existing.expectEvent = true;
      existing.endsAt = now + AGENT_WRITE_WINDOW_MS;
      this.clock.clearTimeout(existing.timer);
      existing.timer = this.clock.setTimeout(() => void this.settleAgentWindow(path), AGENT_WRITE_WINDOW_MS);
      return;
    }
    this.pendingAgent.set(path, {
      frozen: this.baseline.get(path),
      agentSnap: null,
      expectEvent: true,
      endsAt: now + AGENT_WRITE_WINDOW_MS,
      timer: this.clock.setTimeout(() => void this.settleAgentWindow(path), AGENT_WRITE_WINDOW_MS),
    });
  }

  private isAgentWrite(path: string): boolean {
    const at = this.agentWrites.get(path);
    return at !== undefined && this.clock.now() - at <= AGENT_WRITE_WINDOW_MS;
  }

  /**
   * 抑制窗口结束：按实际 diff 补计窗口内人的编辑。
   * 基准优先取 Agent 写入事件的快照（Agent 的词不计入人类统计）；
   * Agent 事件未到达（如写入前抛错）时回退冻结的人类基线，人的编辑照常补计。
   */
  private async settleAgentWindow(path: string): Promise<void> {
    const pending = this.pendingAgent.get(path);
    if (!pending) return;
    this.pendingAgent.delete(path);
    this.clock.clearTimeout(pending.timer);
    this.agentWrites.delete(path);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.baseline.delete(path);
      return;
    }
    const final = await this.snapshot(file);
    const base = pending.agentSnap ?? pending.frozen ?? final;
    this.baseline.set(path, final);
    if (!file.path.endsWith(".md") || this.isExcluded(file.path)) return;
    const added = Math.max(0, final.words - base.words);
    const removed = Math.max(0, base.words - final.words);
    const tasks = Math.max(0, final.tasks - base.tasks);
    if (added === 0 && removed === 0 && tasks === 0) return;
    this.countEdit(file, added, removed, tasks);
  }

  private async snapshot(file: TFile): Promise<FileBaseline> {
    try {
      const text = await this.plugin.app.vault.cachedRead(file);
      return { words: countWords(text), tasks: countCheckedTasks(text) };
    } catch {
      return { words: 0, tasks: 0 };
    }
  }

  /** 插件自身产出的目录（日记/复盘/工作日志/备份）不计入人类写作统计。 */
  private isExcluded(path: string): boolean {
    return isPathInFolders(path, pluginOwnedFolders(this.store.settings));
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
    } catch {
      // 读不到就按空文件处理
    }
    const snap = { words: countWords(text), tasks: countCheckedTasks(text) };
    this.baseline.set(file.path, snap);
    // Agent 新建的笔记只计 aiWordsAdded（由 API 侧记录），这里只更新基线。
    if (this.isAgentWrite(file.path)) {
      const pending = this.pendingAgent.get(file.path);
      if (pending) {
        pending.agentSnap = snap;
        pending.expectEvent = false;
      }
      return;
    }
    if (snap.words > 0) {
      const hour = new Date(this.clock.now()).getHours();
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

    const pending = this.pendingAgent.get(file.path);
    if (pending) {
      if (this.clock.now() < pending.endsAt) {
        // 抑制期内暂缓基线更新：Agent 自身事件记为基准快照，
        // 人的编辑留到窗口结束按实际 diff 补计，不再被吞。
        if (pending.expectEvent) {
          pending.agentSnap = snap;
          pending.expectEvent = false;
        }
        return;
      }
      await this.settleAgentWindow(file.path);
      // settle 已按最新快照更新基线并补计 diff；此处的 snap 是 settle 前的旧快照，
      // 继续执行会把基线回退并重复计分，直接返回。
      return;
    }

    const prev = this.baseline.get(file.path);
    this.baseline.set(file.path, snap);
    // 无基线的文件只建立基线，不按 {0,0} 把整篇内容误计为新增。
    if (!prev) return;

    const added = Math.max(0, snap.words - prev.words);
    const removed = Math.max(0, prev.words - snap.words);
    const tasks = Math.max(0, snap.tasks - prev.tasks);
    if (added === 0 && removed === 0 && tasks === 0) return;
    this.countEdit(file, added, removed, tasks);
  }

  /** 把一次人类编辑 diff 计入当天指标。 */
  private countEdit(file: TFile, added: number, removed: number, tasks: number): void {
    const hour = new Date(this.clock.now()).getHours();
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
    const now = new Date(this.clock.now());
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
    const today = dateKey(new Date(this.clock.now()));
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