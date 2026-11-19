import { TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import { buildWeeklyReview } from "../features/review";
import type { DayRecord, MemoRecord, WorkLogRecord } from "../types";
import { addDays, dateKey, hhmm, lastNDays, parseKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

export interface NoteSummary {
  path: string;
  title: string;
  folder: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
}

export interface TodaySnapshot {
  date: string;
  contribution: number;
  active: boolean;
  streak: number;
  notesCreated: number;
  wordsAdded: number;
  tasksCompleted: number;
  memos: number;
  backlog: number;
}

export interface WorkLogInput {
  agent?: string;
  task?: string;
  summary?: string;
  decisions?: string;
  files?: string[];
  learnings?: string;
  openQuestions?: string;
  tags?: string[];
}

export interface KnowledgeInput {
  title: string;
  content: string;
  folder?: string;
  tags?: string[];
  agent?: string;
  source?: string;
  links?: string[];
}

/** 智能体开工时拉取的上下文包。 */
export interface DailyContext {
  generatedAt: string;
  today: TodaySnapshot;
  backlog: number;
  workLogs: WorkLogRecord[];
  memos: MemoRecord[];
  notes: NoteSummary[];
}

/** 生成随机访问令牌，优先用 Web Crypto。 */
export function generateToken(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch (error) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** 阻止路径逃逸出库外。 */
function safePath(input: string): string {
  const path = String(input ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!path) throw new Error("路径不能为空");
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("非法路径：不允许 . 或 ..");
  }
  if (!path.toLowerCase().endsWith(".md")) throw new Error("只支持 .md 笔记");
  return path;
}

/**
 * 提供给 Agent / 脚本的高层知识库接口。
 * 同一实例同时挂在插件对象、window.Sediment 和本地 HTTP 服务上。
 */
export class AgentApi {
  constructor(private plugin: SedimentPlugin) {}

  private get vault() {
    return this.plugin.app.vault;
  }

  /** 列出笔记。folder 为空表示整个库。 */
  listNotes(folder = "", limit = 50): NoteSummary[] {
    const prefix = normalizeFolder(folder).toLowerCase();
    return this.vault
      .getMarkdownFiles()
      .filter((file) => !prefix || file.path.toLowerCase().startsWith(`${prefix}/`))
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map((file) => ({
        path: file.path,
        title: file.basename,
        folder: file.parent?.path ?? "/",
      }));
  }

  /** 全文搜索，返回命中片段。 */
  async searchNotes(query: string, limit = 10): Promise<SearchResult[]> {
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return [];
    const results: SearchResult[] = [];
    for (const file of this.vault.getMarkdownFiles()) {
      if (results.length >= Math.max(1, Math.min(limit, 100))) break;
      const text = await this.vault.cachedRead(file);
      const position = text.toLowerCase().indexOf(needle);
      if (position < 0) continue;
      const start = Math.max(0, position - 60);
      const end = Math.min(text.length, position + needle.length + 160);
      results.push({
        path: file.path,
        title: file.basename,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
    return results;
  }

  /** 读取笔记全文。 */
  async readNote(path: string): Promise<{ path: string; content: string }> {
    const safe = safePath(path);
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    return { path: safe, content: await this.vault.read(file) };
  }

  /** 新建、覆盖或追加笔记。 */
  async writeNote(path: string, content: string, mode: "create" | "overwrite" | "append" = "create"): Promise<{ path: string }> {
    const safe = safePath(path);
    const folder = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
    await ensureFolder(this.vault, folder);
    const existing = this.vault.getAbstractFileByPath(safe);

    if (mode === "create" && existing) throw new Error(`笔记已存在：${safe}`);
    if (mode === "append" && existing instanceof TFile) {
      const previous = await this.vault.read(existing);
      await this.vault.modify(existing, `${previous.trimEnd()}\n\n${content}`);
    } else if (existing instanceof TFile) {
      await this.vault.modify(existing, content);
    } else {
      await this.vault.create(safe, content);
    }
    return { path: safe };
  }

  /** 记一条速记，写入当天日记。 */
  async addMemo(text: string, tags: string[] = []): Promise<MemoRecord | null> {
    return this.plugin.memos.add(text, tags);
  }

  /** 最近若干天的完整指标。 */
  getStats(days = 30): Array<DayRecord & { date: string }> {
    const count = Math.max(1, Math.min(days, 370));
    return lastNDays(count).map((date) => ({ date, ...this.plugin.store.getDay(date) }));
  }

  /** 今日快照，口径与看板一致。 */
  getToday(): TodaySnapshot {
    const store = this.plugin.store;
    const date = dateKey(new Date());
    const day = store.getDay(date);

    let streak = 0;
    let cursor = new Date();
    if (store.getDay(dateKey(cursor)).contribution === 0) cursor = new Date(cursor.getTime() - 86400000);
    while (store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = new Date(cursor.getTime() - 86400000);
    }

    const todayMemos = store.data.memos.filter((memo) => memo.date === date);
    return {
      date,
      contribution: day.contribution,
      active: day.contribution > 0,
      streak,
      notesCreated: day.notesCreated,
      wordsAdded: day.wordsAdded,
      tasksCompleted: day.tasksCompleted,
      memos: todayMemos.length,
      backlog: store.data.memos.filter((memo) => !memo.converted).length,
    };
  }

  getMemos(limit = 20): MemoRecord[] {
    return this.plugin.store.data.memos.slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getBacklog(): { count: number } {
    return { count: this.plugin.store.data.memos.filter((memo) => !memo.converted).length };
  }

  /**
   * 记录一次 Agent 工作会话。同时写入 agent-logs/YYYY-MM-DD.md 与 data.json，
   * 让每天的工作过程成为可检索的沉淀。
   */
  async recordWorkLog(input: WorkLogInput): Promise<WorkLogRecord> {
    const now = new Date();
    const log: WorkLogRecord = {
      id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      date: dateKey(now),
      time: hhmm(now),
      agent: String(input.agent || "agent").slice(0, 40),
      task: String(input.task || "").trim(),
      summary: String(input.summary || "").trim(),
      decisions: String(input.decisions || "").trim(),
      files: Array.isArray(input.files) ? input.files.map(String) : [],
      learnings: String(input.learnings || "").trim(),
      openQuestions: String(input.openQuestions || "").trim(),
      tags: Array.isArray(input.tags)
        ? input.tags.map((tag) => String(tag).replace(/^#/, ""))
        : [],
    };

    const folder = normalizeFolder(this.plugin.store.settings.workLogFolder);
    await ensureFolder(this.vault, folder);
    const path = folder ? `${folder}/${log.date}.md` : `${log.date}.md`;
    const abstract = this.vault.getAbstractFileByPath(path);
    const file: TFile =
      abstract instanceof TFile
        ? abstract
        : await this.vault.create(path, `# 工作日志 ${log.date}\n\n`);
    const previous = await this.vault.read(file);

    const block = [
      `## ${log.time} · ${log.agent}`,
      "",
      `- **任务**：${log.task || "—"}`,
      `- **完成**：${log.summary || "—"}`,
      `- **决策**：${log.decisions || "—"}`,
      log.files.length
        ? `- **涉及文件**：${log.files.map((item) => `\`${item}\``).join("、")}`
        : "",
      `- **学到的东西**：${log.learnings || "—"}`,
      `- **待确认**：${log.openQuestions || "—"}`,
      log.tags.length ? `- **标签**：${log.tags.map((tag) => `#${tag}`).join(" ")}` : "",
      "",
    ].join("\n");

    await this.vault.modify(file, `${previous.trimEnd()}\n\n${block}`);
    this.plugin.store.addWorkLog(log);
    return log;
  }

  /** 把一段知识沉淀成带 frontmatter 的独立笔记。 */
  async addKnowledge(input: KnowledgeInput): Promise<{ path: string }> {
    const title = String(input.title || "未命名笔记").trim();
    const safeTitle =
      title.replace(/[\\/:*?"<>|#\[\]]/g, "-").slice(0, 80) || "未命名笔记";
    const base = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    const sub = normalizeFolder(input.folder ?? "");
    const folder = [base, sub].filter(Boolean).join("/");
    await ensureFolder(this.vault, folder);

    const today = dateKey(new Date());
    let fileName = `${today}-${safeTitle}.md`;
    let path = folder ? `${folder}/${fileName}` : fileName;
    let counter = 2;
    while (this.vault.getAbstractFileByPath(path)) {
      fileName = `${today}-${safeTitle}-${counter}.md`;
      path = folder ? `${folder}/${fileName}` : fileName;
      counter += 1;
    }

    const tags = Array.isArray(input.tags)
      ? input.tags.map((tag) => String(tag).replace(/^#/, ""))
      : [];
    const links = Array.isArray(input.links) ? input.links.map(String) : [];
    const agent = String(input.agent || "agent").replace(/[:#]/g, "-");
    const yaml = [
      "---",
      `date: ${today}`,
      "type: knowledge",
      "source: agent",
      `agent: ${agent}`,
      ...(input.source ? [`origin: ${String(input.source).replace(/[:#]/g, "-")}`] : []),
      tags.length ? "tags:" : "tags: []",
      ...tags.map((tag) => `  - ${tag}`),
      links.length ? "links:" : "links: []",
      ...links.map((link) => `  - "${link.replace(/"/g, '\\"')}"`),
      "---",
      "",
      `# ${title}`,
      "",
      String(input.content || ""),
      "",
    ].join("\n");

    await this.vault.create(path, yaml);
    return { path };
  }

  /** 最近 N 天的工作日志。 */
  listWorkLogs(days = 7): WorkLogRecord[] {
    const count = Math.max(1, Math.min(days, 370));
    const since = dateKey(addDays(new Date(), -(count - 1)));
    return this.plugin.store.data.workLogs.filter((log) => log.date >= since);
  }

  /** 智能体开工时一次拿全需要的上下文。 */
  getDailyContext(days = 7): DailyContext {
    return {
      generatedAt: dateKey(new Date()),
      today: this.getToday(),
      backlog: this.getBacklog().count,
      workLogs: this.listWorkLogs(days),
      memos: this.getMemos(10),
      notes: this.listNotes("", 10),
    };
  }

  /** 生成周复盘 Markdown（不落盘）。 */
  generateWeeklyReview(date?: string): { date: string; markdown: string } {
    const anchor = date ? parseKey(date) : new Date();
    return { date: dateKey(anchor), markdown: buildWeeklyReview(this.plugin.store, anchor) };
  }
}
