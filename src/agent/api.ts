import { normalizePath, TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import { buildWeeklyReview } from "../features/review";
import type { PomodoroState } from "../features/pomodoro";
import { countWords } from "../tracking/tracker";
import { restoreBackup } from "../features/audit";
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
  /** 知识库分类，会作为 knowledge 下的子目录 */
  category?: string;
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
  /** 带 #to-agent 且未完成的任务 */
  agentTasks: MemoRecord[];
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

function versionOf(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 极简 unified diff：显示首个差异到末个差异之间的增删行。 */
function simpleDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const lines = ["--- before", "+++ after"];
  for (let index = start; index < endOld; index += 1) lines.push(`-${oldLines[index]}`);
  for (let index = start; index < endNew; index += 1) lines.push(`+${newLines[index]}`);
  return lines.join("\n");
}

function lineChanges(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  return {
    addedLines: newLines.filter((line) => !oldLines.includes(line)).length,
    removedLines: oldLines.filter((line) => !newLines.includes(line)).length,
  };
}

function yamlLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => `  - ${JSON.stringify(String(item))}`) : ["[]"];
  }
  if (value === null || value === undefined) return ["null"];
  return [JSON.stringify(value)];
}

function findSection(
  text: string,
  heading: string,
  index: number
): { start: number; end: number; lines: string[] } | null {
  const lines = text.split("\n");
  const headingMatch = heading.match(/^(#{1,6})\s+(.*)$/);
  const level = headingMatch ? headingMatch[1].length : 0;
  const target = headingMatch ? headingMatch[2].trim() : heading.trim();
  const matches: Array<{ line: number; level: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!match) continue;
    if (match[2].trim() === target && (level === 0 || match[1].length === level)) {
      matches.push({ line: i, level: match[1].length });
    }
  }
  const chosen = matches[index];
  if (!chosen) return null;
  let end = lines.length;
  for (let i = chosen.line + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= chosen.level) {
      end = i;
      break;
    }
  }
  return { start: chosen.line + 1, end, lines };
}

/** 带机器可读错误码的 API 异常，HTTP 层据此返回 4xx。 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 阻止路径逃逸出库外。 */
function safePath(input: string): string {
  const path = normalizePath(String(input ?? ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!path) throw new ApiError("EMPTY_PATH", "路径不能为空");
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    throw new ApiError("FORBIDDEN", "非法路径：不允许 . 或 ..");
  }
  const lower = path.toLowerCase();
  if (lower === ".obsidian" || lower.startsWith(".obsidian/") || lower === ".git" || lower.startsWith(".git/")) {
    throw new ApiError("FORBIDDEN", "系统目录禁止访问");
  }
  if (!lower.endsWith(".md")) throw new ApiError("INVALID_EXTENSION", "只支持 .md 笔记");
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

  private currentTool = "";
  private currentAgent = "";

  setCallContext(tool: string, agent: string): void {
    this.currentTool = tool;
    this.currentAgent = agent;
  }

  /** 写入前把原文快照存到插件 backups 目录，返回快照 id。 */
  private backupNote(path: string, content: string): string {
    if (!this.plugin.store.settings.enableAuditSnapshot) return "";
    try {
      const adapter = this.plugin.app.vault.adapter as unknown as {
        getFullPath?: (normalizedPath: string) => string;
      };
      if (!adapter.getFullPath) return "";
      const fs = require("fs") as typeof import("fs");
      const directory = adapter.getFullPath(
        `${this.plugin.app.vault.configDir}/plugins/sediment/backups`
      );
      fs.mkdirSync(directory, { recursive: true });
      const id = `${Date.now()}-${path.replace(/[\\/]/g, "_")}`;
      fs.writeFileSync(`${directory}/${id}`, content, "utf8");
      const files = fs.readdirSync(directory).sort();
      while (files.length > 20) {
        const old = files.shift();
        if (old) fs.unlinkSync(`${directory}/${old}`);
      }
      this.plugin.store.addSnapshot({
        id,
        path,
        time: new Date().toISOString(),
        tool: this.currentTool,
        agent: this.currentAgent,
      });
      return id;
    } catch (error) {
      return "";
    }
  }

  private deniedFolders(): string[] {
    return splitList(this.plugin.store.settings.deniedFolders);
  }

  private deniedTags(): string[] {
    return splitList(this.plugin.store.settings.deniedTags);
  }

  private isDeniedPath(path: string): boolean {
    return this.deniedFolders().some((folder) => path === folder || path.startsWith(`${folder}/`));
  }

  private assertAllowed(path: string): void {
    if (this.isDeniedPath(path)) {
      throw new ApiError("FORBIDDEN", `访问被拒绝：${path} 位于黑名单目录`, 403);
    }
  }

  private assertOperation(operation: "read" | "create" | "patch" | "overwrite" | "delete"): void {
    const settings = this.plugin.store.settings;
    const allowed =
      operation === "read"
        ? settings.agentAllowRead
        : operation === "create"
          ? settings.agentAllowCreate
          : operation === "patch"
            ? settings.agentAllowPatch
            : operation === "overwrite"
              ? settings.agentAllowOverwrite
              : settings.agentAllowDelete;
    if (!allowed) {
      throw new ApiError("OPERATION_DENIED", `操作 ${operation} 未被允许`, 403);
    }
  }

  private assertPathAllowed(path: string, operation: "read" | "create" | "patch" | "overwrite" | "delete"): void {
    this.assertOperation(operation);
    this.assertAllowed(path);
    const settings = this.plugin.store.settings;
    if (settings.agentAccessMode === "allowlist") {
      const folders = splitList(settings.agentAllowedFolders);
      if (!folders.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
        throw new ApiError("FORBIDDEN", `访问被拒绝：${path} 不在白名单目录内`, 403);
      }
    }
  }

  private isAllowedByMode(path: string): boolean {
    if (this.isDeniedPath(path)) return false;
    const settings = this.plugin.store.settings;
    if (settings.agentAccessMode !== "allowlist") return true;
    return splitList(settings.agentAllowedFolders).some(
      (folder) => path === folder || path.startsWith(`${folder}/`)
    );
  }

  private cacheTags(file: TFile): string[] {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const tags = new Set<string>();
    for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ""));
    const frontmatterTags = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
    if (Array.isArray(frontmatterTags)) {
      for (const tag of frontmatterTags) tags.add(String(tag).replace(/^#/, ""));
    } else if (typeof frontmatterTags === "string") {
      for (const tag of frontmatterTags.split(/[,，\s]+/).filter(Boolean)) {
        tags.add(tag.replace(/^#/, ""));
      }
    }
    return [...tags];
  }

  private hasDeniedTag(file: TFile): boolean {
    const denied = this.deniedTags();
    return denied.length > 0 && this.cacheTags(file).some((tag) => denied.includes(tag));
  }

  /** 列出笔记。folder 为空表示整个库。 */
  listNotes(folder = "", limit = 50): NoteSummary[] {
    const prefix = normalizeFolder(folder).toLowerCase();
    return this.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          (!prefix || file.path.toLowerCase().startsWith(`${prefix}/`)) &&
          this.isAllowedByMode(file.path) &&
          !this.hasDeniedTag(file)
      )
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
      if (!this.isAllowedByMode(file.path) || this.hasDeniedTag(file)) continue;
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
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    if (this.hasDeniedTag(file)) throw new Error(`访问被拒绝：${safe} 带有禁止访问的标签`);
    return { path: safe, content: await this.vault.read(file) };
  }

  /** 新建、覆盖或追加笔记。 */
  async writeNote(path: string, content: string, mode: "create" | "overwrite" | "append" = "create"): Promise<{ path: string }> {
    const safe = safePath(path);
    this.assertPathAllowed(
      safe,
      mode === "overwrite" ? "overwrite" : mode === "append" ? "patch" : "create"
    );
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
    this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => {
      day.aiWordsAdded += countWords(content);
    });
    return { path: safe };
  }

  /** 记一条速记，写入当天日记。 */
  async addMemo(
    text: string,
    tags: string[] = [],
    sourcePath?: string,
    sourceLine?: number
  ): Promise<MemoRecord | null> {
    return this.plugin.memos.add(
      text,
      tags,
      sourcePath ? { path: sourcePath, line: sourceLine ?? 1 } : undefined
    );
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

  /** 当前打开的笔记、选中文本与光标所在段落。 */
  getActiveContext(): {
    file: string | null;
    selection: string;
    cursorLine: number;
    cursorParagraph: string;
  } {
    const workspace = this.plugin.app.workspace;
    let file = workspace.getActiveFile();
    if (!file) {
      // 主区开着看板/图谱时没有 activeFile，回退到最近一个 Markdown 标签页。
      const leaf = workspace
        .getLeavesOfType("markdown")
        .find((item) => Boolean((item.view as { file?: TFile | null }).file));
      file = (leaf?.view as { file?: TFile | null } | undefined)?.file ?? null;
    }
    const editor = workspace.activeEditor?.editor;
    if (!file || this.isDeniedPath(file.path)) {
      return { file: null, selection: "", cursorLine: 0, cursorParagraph: "" };
    }
    const selection = editor?.getSelection() ?? "";
    const cursor = editor?.getCursor() ?? { line: 0, ch: 0 };
    let cursorParagraph = "";
    if (editor) {
      let start = cursor.line;
      let end = cursor.line;
      while (start > 0 && editor.getLine(start - 1).trim() !== "") start -= 1;
      while (end < editor.lineCount() - 1 && editor.getLine(end + 1).trim() !== "") end += 1;
      cursorParagraph = editor.getRange(
        { line: start, ch: 0 },
        { line: end, ch: editor.getLine(end).length }
      );
    }
    return { file: file.path, selection, cursorLine: cursor.line + 1, cursorParagraph };
  }

  /** 本地语义检索（TF-IDF + 同义词），不联网。 */
  async semanticSearch(query: string, limit = 10): Promise<Array<{ path: string; score: number; snippet: string }>> {
    return this.plugin.semantic.search(String(query ?? ""), limit);
  }

  /** 只读元数据，不返回正文，节省 Agent 的 Token。 */
  async getNoteMetadata(path: string): Promise<{
    path: string;
    frontmatter: Record<string, unknown>;
    tags: string[];
    headings: string[];
    links: string[];
  }> {
    const safe = safePath(path);
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    return {
      path: safe,
      frontmatter: (cache?.frontmatter ?? {}) as Record<string, unknown>,
      tags: this.cacheTags(file),
      headings: (cache?.headings ?? []).map((heading) => `${"#".repeat(heading.level)} ${heading.heading}`),
      links: (cache?.links ?? []).map((link) => link.link),
    };
  }

  /** 1-hop 图谱：出链、反链与同标签笔记。 */
  getGraphNeighbors(
    path: string,
    include: string[] = ["outgoing", "backlinks", "tags"]
  ): { path: string; outgoing: string[]; backlinks: string[]; sameTag: string[] } {
    const safe = safePath(path);
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);

    const resolved = (this.plugin.app.metadataCache.resolvedLinks ?? {}) as Record<
      string,
      Record<string, number>
    >;
    const allowed = (target: string): boolean =>
      !this.isDeniedPath(target) && target !== safe;

    const outgoing = include.includes("outgoing")
      ? Object.keys(resolved[safe] ?? {}).filter(allowed)
      : [];
    const backlinks = include.includes("backlinks")
      ? Object.entries(resolved)
          .filter(([source, links]) => allowed(source) && Object.prototype.hasOwnProperty.call(links, safe))
          .map(([source]) => source)
      : [];

    let sameTag: string[] = [];
    if (include.includes("tags")) {
      const targetTags = new Set(this.cacheTags(file));
      sameTag = this.vault
        .getMarkdownFiles()
        .filter((other) => allowed(other.path) && !this.hasDeniedTag(other))
        .filter((other) => this.cacheTags(other).some((tag) => targetTags.has(tag)))
        .map((other) => other.path);
    }
    return { path: safe, outgoing, backlinks, sameTag };
  }

  /** 按标题或文本片段局部修改笔记；支持 dryRun、乐观锁、快照与 diff 统计。 */
  async patchNote(input: {
    path: string;
    heading?: string;
    find?: string;
    content: string;
    mode?: "replace" | "append" | "prepend";
    operation?: "append_under_heading" | "prepend_under_heading" | "replace_block" | "update_frontmatter";
    index?: number;
    ifMatch?: string;
    expectedMtime?: number;
    dryRun?: boolean;
  }): Promise<{
    path: string;
    version: string;
    mtime: number;
    snapshotId?: string;
    diffSummary: { addedLines: number; removedLines: number };
    previewDiff?: string;
    createdHeading?: boolean;
  }> {
    const safe = safePath(input.path);
    this.assertPathAllowed(safe, "patch");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new ApiError("NOT_FOUND", `笔记不存在：${safe}`, 404);
    const before = await this.vault.read(file);

    if (typeof input.expectedMtime === "number" && input.expectedMtime !== file.stat.mtime) {
      throw new ApiError("VERSION_CONFLICT", `文件已被修改：${safe}，请重新读取后再写入`, 409);
    }
    if (input.ifMatch && versionOf(before) !== input.ifMatch) {
      throw new ApiError("VERSION_CONFLICT", `版本冲突：${safe} 已被修改，请重新读取后再写入`, 409);
    }

    if (input.operation === "update_frontmatter") {
      let updates: Record<string, unknown>;
      try {
        updates = JSON.parse(String(input.content ?? "{}")) as Record<string, unknown>;
      } catch (error) {
        throw new ApiError("INVALID_JSON", "update_frontmatter 的 content 必须是 JSON 对象字符串");
      }
      const result = await this.updateFrontmatter(safe, updates, input.ifMatch);
      return { ...result, mtime: file.stat.mtime, diffSummary: { addedLines: 0, removedLines: 0 } };
    }

    const content = String(input.content ?? "");
    const mode =
      input.operation === "append_under_heading"
        ? "append"
        : input.operation === "prepend_under_heading"
          ? "prepend"
          : input.mode ?? "replace";
    let createdHeading = false;
    let result = "";

    if (input.find) {
      const positions: number[] = [];
      let from = 0;
      for (;;) {
        const at = before.indexOf(input.find, from);
        if (at < 0) break;
        positions.push(at);
        from = at + input.find.length;
      }
      if (positions.length > 1 && input.index === undefined) {
        throw new ApiError(
          "AMBIGUOUS_MATCH",
          `文本片段在文中出现 ${positions.length} 次，请提供更多上下文或指定 index`
        );
      }
      const position = positions[input.index ?? 0];
      if (position === undefined) throw new ApiError("NOT_FOUND", `未找到文本片段：${input.find}`, 404);
      result = before.slice(0, position) + content + before.slice(position + input.find.length);
    } else if (input.heading) {
      const section = findSection(before, input.heading, input.index ?? 0);
      if (!section) {
        createdHeading = true;
        result = `${before.trimEnd()}\n\n${input.heading}\n${content}\n`;
      } else {
        const body = section.lines.slice(section.start, section.end);
        const incoming = content.split("\n");
        const nextBody =
          mode === "replace" ? incoming : mode === "append" ? [...body, "", ...incoming] : [...incoming, "", ...body];
        result = [
          ...section.lines.slice(0, section.start),
          ...nextBody,
          ...section.lines.slice(section.end),
        ].join("\n");
      }
    } else {
      throw new ApiError("MISSING_ANCHOR", "patch_note 需要 heading 或 find 参数");
    }

    const diffSummary = lineChanges(before, result);
    if (input.dryRun) {
      return {
        path: safe,
        version: versionOf(result),
        mtime: file.stat.mtime,
        diffSummary,
        previewDiff: simpleDiff(before, result),
        createdHeading,
      };
    }

    const snapshotId = this.backupNote(safe, before);
    await this.vault.process(file, () => result);
    this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => {
      day.aiWordsAdded += countWords(content);
    });
    return {
      path: safe,
      version: versionOf(result),
      mtime: file.stat.mtime,
      snapshotId: snapshotId || undefined,
      diffSummary,
      createdHeading,
    };
  }

  /** 单独更新 frontmatter 字段，不动正文。 */
  async updateFrontmatter(
    path: string,
    updates: Record<string, unknown>,
    ifMatch?: string
  ): Promise<{ path: string; version: string }> {
    const safe = safePath(path);
    this.assertPathAllowed(safe, "patch");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    const before = await this.vault.read(file);
    if (ifMatch && versionOf(before) !== ifMatch) {
      throw new Error(`版本冲突：${safe} 已被修改，请重新读取后再写入`);
    }
    this.backupNote(safe, before);

    let result = "";
    await this.vault.process(file, (data) => {
      const lines = data.split("\n");
      let start = -1;
      let end = -1;
      if (lines[0]?.trim() === "---") {
        for (let i = 1; i < lines.length; i += 1) {
          if (lines[i].trim() === "---") {
            end = i;
            break;
          }
        }
        if (end < 0) throw new Error("frontmatter 未闭合");
        start = 1;
      }
      const block = start >= 0 ? lines.slice(start, end) : [];
      for (const [key, value] of Object.entries(updates)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const targetIndex = block.findIndex((line) =>
          new RegExp(`^${escaped}\\s*:`).test(line)
        );
        const replacement = Array.isArray(value)
          ? value.length
            ? [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(String(item))}`)]
            : [`${key}: []`]
          : [`${key}: ${JSON.stringify(value)}`];
        if (targetIndex >= 0) block.splice(targetIndex, 1, ...replacement);
        else block.push(...replacement);
      }
      result =
        start >= 0
          ? [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n")
          : ["---", ...block, "---", "", ...lines].join("\n");
      return result;
    });
    return { path: safe, version: versionOf(result) };
  }

  logToolCall(tool: string, agent: string, path: string): void {
    this.plugin.store.logToolCall({ time: new Date().toISOString(), tool, agent, path });
  }

  getToolActivity(): {
    total: number;
    byTool: Record<string, number>;
    byAgent: Record<string, number>;
    recent: Array<{ time: string; tool: string; agent: string; path: string }>;
  } {
    const byTool: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const call of this.plugin.store.data.toolCalls) {
      byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
      byAgent[call.agent || "unknown"] = (byAgent[call.agent || "unknown"] ?? 0) + 1;
    }
    return {
      total: this.plugin.store.data.toolCalls.length,
      byTool,
      byAgent,
      recent: this.plugin.store.data.toolCalls.slice(0, 20),
    };
  }

  private categories(): string[] {
    return this.plugin.store.settings.knowledgeCategories
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  /** 知识库分类及各分类下的笔记数。 */
  getCategories(): { categories: string[]; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const base = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    for (const file of this.vault.getMarkdownFiles()) {
      if (!base || !file.path.startsWith(`${base}/`)) continue;
      const parts = file.path.split("/");
      const category = parts.length > 1 ? parts[1] : "未分类";
      counts[category] = (counts[category] ?? 0) + 1;
    }
    const all = [...new Set([...this.categories(), ...Object.keys(counts)])];
    return { categories: all, counts };
  }

  /** 根据标题、标签和正文关键词推断分类；Agent 也可自行指定任意分类名。 */
  private inferCategory(title: string, content: string, tags: string[]): string {
    const text = `${title} ${tags.join(" ")} ${content.slice(0, 600)}`.toLowerCase();
    const rules: Array<[string, RegExp]> = [
      ["复盘", /复盘|总结|周报|回顾|小结|review|retro/],
      ["项目", /项目|计划|需求|进度|里程碑|project|任务拆解/],
      ["技术", /代码|插件|api|mcp|配置|报错|调试|开发|构建|故障|排查|排错|发布|维护|bug|error|code|build|技术/],
      ["方法", /工作流|提示词|步骤|规范|指南|流程|方法|workflow|prompt|howto|教程/],
      ["灵感", /想法|灵感|点子|随想|idea/],
    ];
    for (const [category, pattern] of rules) {
      if (pattern.test(text)) return category;
    }
    return this.categories()[0] ?? "未分类";
  }

  async listTasks(scope = "all"): Promise<Array<{ path: string; line: number; text: string; date: string; checked: boolean }>> {
    return this.plugin.tasks.list(scope as "today" | "overdue" | "all" | "agent");
  }

  async completeTask(path: string, line: number): Promise<{ ok: true }> {
    await this.plugin.tasks.complete(path, line);
    return { ok: true };
  }

  async delegateTask(path: string, line: number): Promise<{ id: string }> {
    return { id: await this.plugin.tasks.delegate(path, line) };
  }

  async snapshotTasks(): Promise<{ count: number }> {
    return { count: await this.plugin.tasks.snapshot() };
  }

  /** 最近 Agent 变更及其快照 id。 */
  getAgentChanges(limit = 20): Array<{
    id: string;
    path: string;
    time: string;
    tool: string;
    agent: string;
  }> {
    return this.plugin.store.data.snapshots.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async revertAgentChange(snapshotId: string): Promise<{ path: string; reverted: true }> {
    const snapshot = this.plugin.store.data.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) throw new ApiError("NOT_FOUND", `快照不存在：${snapshotId}`, 404);
    const file = this.vault.getAbstractFileByPath(snapshot.path);
    if (!(file instanceof TFile)) throw new ApiError("NOT_FOUND", `笔记不存在：${snapshot.path}`, 404);
    await restoreBackup(this.plugin, file, snapshotId);
    return { path: snapshot.path, reverted: true };
  }

  getPomodoro(): PomodoroState {
    return this.plugin.pomodoro.state();
  }

  controlPomodoro(action: string): PomodoroState {
    const pomodoro = this.plugin.pomodoro;
    if (action === "start") pomodoro.start();
    else if (action === "pause") pomodoro.pause();
    else if (action === "reset") pomodoro.reset();
    else if (action === "skip") pomodoro.skip();
    else pomodoro.toggle();
    return pomodoro.state();
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
      "> [!summary] 任务",
      `> ${log.task || "—"}`,
      "",
      "**完成了什么**",
      log.summary || "—",
      "",
      ...(log.decisions ? ["> [!tip] 关键决策", `> ${log.decisions}`, ""] : []),
      ...(log.files.length
        ? ["> [!example] 涉及文件", ...log.files.map((item) => `> - \`${item}\``), ""]
        : []),
      ...(log.learnings ? ["> [!note] 学到的东西", `> ${log.learnings}`, ""] : []),
      ...(log.openQuestions ? ["> [!question] 待确认", `> ${log.openQuestions}`, ""] : []),
      log.tags.length ? `标签：${log.tags.map((tag) => `#${tag}`).join(" ")}` : "",
      "",
    ].join("\n");

    await this.vault.modify(file, `${previous.trimEnd()}\n\n${block}`);
    this.plugin.store.updateDay(log.date, (day) => {
      day.aiWordsAdded += countWords(block);
    });
    this.plugin.store.addWorkLog(log);
    return log;
  }

  /** 把一段知识沉淀成带 frontmatter 的独立笔记。 */
  async addKnowledge(input: KnowledgeInput): Promise<{ path: string }> {
    const title = String(input.title || "未命名笔记").trim();
    const safeTitle =
      title.replace(/[\\/:*?"<>|#\[\]]/g, "-").slice(0, 80) || "未命名笔记";
    const base = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    const categories = this.categories();
    const tags = Array.isArray(input.tags)
      ? input.tags.map((tag) => String(tag).replace(/^#/, ""))
      : [];
    const links = Array.isArray(input.links) ? input.links.map(String) : [];
    const agent = String(input.agent || "agent").replace(/[:#]/g, "-");
    const requestedCategory = String(input.category ?? "").trim();
    const category =
      requestedCategory ||
      (tags.length || String(input.content ?? "").length > 0
        ? this.inferCategory(title, String(input.content ?? ""), tags)
        : categories[0]) ||
      "未分类";
    const sub = normalizeFolder(input.folder ?? "");
    const folder = [base, category, sub].filter(Boolean).join("/");
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

    const frontmatter = [
      "---",
      `date: ${today}`,
      "type: knowledge",
      "source: agent",
      "sediment_status: draft",
      `category: ${category}`,
      `agent: ${agent}`,
      ...(input.source ? [`origin: ${String(input.source).replace(/[:#]/g, "-")}`] : []),
      tags.length ? "tags:" : "tags: []",
      ...tags.map((tag) => `  - ${tag}`),
      links.length ? "links:" : "links: []",
      ...links.map((link) => `  - "${link.replace(/"/g, '\\"')}"`),
      "---",
    ].join("\n");

    const body = String(input.content || "").trim();
    const firstLine = body.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    const summary = firstLine.replace(/^[#>\-*0-9.\s]+/, "").slice(0, 120) || "—";
    const doc = [
      frontmatter,
      "",
      `# ${title}`,
      "",
      "> [!abstract] 速览",
      `> ${summary}`,
      "",
      "## 正文",
      "",
      body || "—",
      "",
      "## 关联与来源",
      ...(input.source ? [`- 来源：\`${String(input.source)}\``] : []),
      ...(links.length ? links.map((link) => `- 关联：[[${link}]]`) : ["- 关联：—"]),
      "",
      "## 标签",
      tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "—",
      "",
      "---",
      "> [!info]- 沉淀信息",
      `> 由 **${agent}** 于 ${today} 写入 · Sediment`,
      "",
    ].join("\n");

    this.assertPathAllowed(path, "create");
    await this.vault.create(path, doc);
    this.plugin.store.updateDay(today, (day) => {
      day.aiWordsAdded += countWords(doc);
    });
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
      agentTasks: this.plugin.store.data.memos.filter(
        (memo) => memo.tags.includes("to-agent") && !memo.converted
      ),
    };
  }

  /** 认领一条 #to-agent 任务，避免被重复处理。 */
  claimAgentTask(id: string): MemoRecord {
    const memo = this.plugin.store.data.memos.find((item) => item.id === id);
    if (!memo) throw new Error(`速记不存在：${id}`);
    if (!memo.tags.includes("to-agent")) throw new Error(`速记 ${id} 不是待办任务`);
    memo.tags = memo.tags.filter((tag) => tag !== "to-agent");
    if (!memo.tags.includes("agent-in-progress")) memo.tags.push("agent-in-progress");
    this.plugin.store.scheduleSave();
    return memo;
  }

  /** 完成任务：标记为 #agent-done，可关联产出笔记。 */
  completeAgentTask(id: string, resultPath?: string): MemoRecord {
    const memo = this.plugin.store.data.memos.find((item) => item.id === id);
    if (!memo) throw new Error(`速记不存在：${id}`);
    memo.tags = memo.tags.filter(
      (tag) => tag !== "to-agent" && tag !== "agent-in-progress" && tag !== "agent-done"
    );
    memo.tags.push("agent-done");
    memo.converted = true;
    if (resultPath) memo.resultPath = resultPath;
    this.plugin.store.scheduleSave();
    return memo;
  }

  /** 生成周复盘 Markdown（不落盘）。 */
  generateWeeklyReview(date?: string): { date: string; markdown: string } {
    const anchor = date ? parseKey(date) : new Date();
    return { date: dateKey(anchor), markdown: buildWeeklyReview(this.plugin.store, anchor) };
  }
}
