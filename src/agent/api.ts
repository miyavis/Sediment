import { normalizePath, TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import type { PomodoroState } from "../features/pomodoro";
import type { DayRecord, MemoRecord, PendingWriteRecord, ToolCallRecord, WorkLogRecord } from "../types";
import { vaultGetFullPath } from "../utils/vault";
import { logError } from "../utils/log-error";
import { ensureDirectory, listDirectory, removeFile, writeTextFile } from "../utils/node";
import { tf } from "../i18n";
import {
  inferCategory,
  isOperationAllowed,
  isPathAllowedByMode,
  isPathDenied,
  listCategories,
  splitList,
  type AgentOperation,
} from "./access";
import type { BridgeProposal, BridgeRejectReason } from "./bridge-schema";
import { reviewMethods } from "./api-review";
import { queryMethods } from "./api-queries";
import { noteQueryMethods } from "./api-note-queries";
import { taskMethods } from "./api-tasks";
import { knowledgeMethods } from "./api-knowledge";
import { noteWriteMethods } from "./api-note-writes";
import { patchMethods } from "./api-patch";
import { applyFrontmatterUpdate, stampAgentProvenance } from "./api-helpers";

// 既有公开 API：测试与外部调用继续从 api.ts 导入这些纯函数。
export { applyFrontmatterUpdate, stampAgentProvenance };

export interface NoteSummary {
  path: string;
  title: string;
  folder: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  matchType: "exact" | "semantic";
  matchSource: "body" | "title" | "tag" | "memo" | "worklog";
  kind?: "note" | "memo" | "worklog" | "draft";
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
  /** 专注分钟与口径：measured = 番茄钟实测 */
  focusMinutes: number;
  focusSource: "measured" | "none";
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
  /** confirm 模式下挂起待审的写入数量（新增可选字段，旧客户端可忽略） */
  pendingWrites: number;
}

/** 生成随机访问令牌：必须使用 CSPRNG，拿不到就抛错，绝不静默降级到可预测的 Math.random。 */
export function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ApiError / AGENT_API_VERSION 定义在 errors.ts 并在此再导出，保持既有导入路径不变；
// api-review.ts 直接依赖 errors.ts，避免 api.ts ↔ api-review.ts 运行时循环依赖。
export { ApiError, AGENT_API_VERSION } from "./errors";
import { ApiError } from "./errors";

/**
 * confirm 工作模式下写路径被挂起时的返回值：不带原字段的结果，
 * 由 HTTP/MCP 原样返回给调用方（旧字段不删除，仅新增可选字段）。
 */
export interface AgentPendingResult {
  pending: true;
  pendingId: string;
  path: string;
  message: string;
}

/** 写入类方法在 confirm 档的返回：直接结果或挂起结果。 */
export type WithPending<T> = T | AgentPendingResult;

/** 文件桥 / 采纳重放使用的写上下文；不参与 HTTP 参数。 */
export interface WriteMeta {
  /** 覆盖来源 Agent 名 */
  agent?: string;
  /** 逻辑工具名，用于快照审计元数据 */
  tool?: string;
  /** 本次 HTTP 调用的流水记录；confirm 挂起时据此标记 held（替代共享可变字段） */
  call?: ToolCallRecord | null;
  /** 文件桥：无条件挂起，不受工作模式影响 */
  hold?: boolean;
  /** 待审记录来源 */
  source?: "bridge";
  /** 文件桥提案 id */
  proposalId?: string;
  /** 指定待审记录 id；缺省时生成 pw-*，文件桥使用 bridge-<提案 id> 以便轮询去重 */
  id?: string;
  /** 采纳重放：仍过门禁但不再挂起 */
  replay?: boolean;
}

/** 阻止路径逃逸出库外；configDir 由调用方从 Vault#configDir 传入，不再假定固定目录名。 */
export function safeAgentPath(input: string, configDir: string): string {
  const path = normalizePath(String(input ?? ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!path) throw new ApiError("EMPTY_PATH", "路径不能为空");
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    throw new ApiError("FORBIDDEN", "非法路径：不允许 . 或 ..");
  }
  const lower = path.toLowerCase();
  const config = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
  const inConfig = config.length > 0 && (lower === config || lower.startsWith(`${config}/`));
  if (inConfig || lower === ".git" || lower.startsWith(".git/")) {
    throw new ApiError("FORBIDDEN", "系统目录禁止访问");
  }
  if (!lower.endsWith(".md")) throw new ApiError("INVALID_EXTENSION", "只支持 .md 笔记");
  return path;
}

/**
 * 文件桥决策回写口：由插件在启用文件桥时注入（Task 3 的 FileBridge）。
 * 这里只声明最小结构，避免 AgentApi 反向依赖文件桥实现。
 */
interface BridgeDecisionSink {
  notifyDecision(
    record: PendingWriteRecord,
    decision: "approved" | "rejected",
    reason: BridgeRejectReason
  ): void;
}

/**
 * 提供给 Agent / 脚本的高层知识库接口。
 * 同一实例同时挂在插件对象、window.Sediment 和本地 HTTP 服务上。
 */
export class AgentApi {
  constructor(public plugin: SedimentPlugin) {}

  public get vault() {
    return this.plugin.app.vault;
  }

  /** 文件桥未启用（或尚未接入）时为 undefined，决策钩子退化成空操作。 */
  public get bridgeSink(): BridgeDecisionSink | undefined {
    return (this.plugin as SedimentPlugin & { fileBridge?: BridgeDecisionSink }).fileBridge;
  }

  /** 正在采纳中的待审 id；防止并发双击 approve 导致同一请求落盘两次。 */
  public approving = new Set<string>();

  /** 构造一次请求专属的写上下文。共享可变字段会让并发请求串上下文，故显式传参。 */
  callMeta(tool: string, agent: string, call: ToolCallRecord | null = null): WriteMeta {
    return { tool, agent, call };
  }

  /** 写入前把原文快照存到插件 backups 目录，返回快照 id。 */
  backupNote(path: string, content: string, meta?: WriteMeta): string {
    if (!this.plugin.store.settings.enableAuditSnapshot) return "";
    try {
      const directory = vaultGetFullPath(
        this.plugin.app.vault,
        `${this.plugin.app.vault.configDir}/plugins/sediment/backups`
      );
      if (!directory) return "";
      ensureDirectory(directory, { recursive: true });
      const id = `${Date.now()}-${path.replace(/[\\/]/g, "_")}`;
      writeTextFile(`${directory}/${id}`, content, "utf8");
      const files = listDirectory(directory).sort();
      // 文件保留数与快照索引上限（200）一致，避免索引里有记录但文件已被清理。
      while (files.length > 200) {
        const old = files.shift();
        if (old) removeFile(`${directory}/${old}`);
      }
      const remaining = new Set(files);
      this.plugin.store.data.snapshots = this.plugin.store.data.snapshots.filter(
        (snapshot) => remaining.has(snapshot.id)
      );
      this.plugin.store.addSnapshot({
        id,
        path,
        time: new Date().toISOString(),
        tool: meta?.tool ?? "",
        agent: meta?.agent ?? "agent",
      });
      return id;
    } catch (error) {
      // 快照失败不阻断写入，但不再静默：记控制台与诊断，供真实环境排查。
      logError(this.plugin.store, "写入前快照创建失败", error);
      return "";
    }
  }

  deniedTags(): string[] {
    return splitList(this.plugin.store.settings.deniedTags);
  }

  isDeniedPath(path: string): boolean {
    return isPathDenied(path, this.plugin.store.settings.deniedFolders);
  }

  assertAllowed(path: string): void {
    if (this.isDeniedPath(path)) {
      const message = tf("访问被拒绝：{path} 位于黑名单目录", { path });
      this.plugin.store.logDiagnostic("security", message);
      throw new ApiError("FORBIDDEN", message, 403);
    }
  }

  assertOperation(operation: AgentOperation): void {
    if (!isOperationAllowed(operation, this.plugin.store.settings)) {
      const message =
        operation !== "read" && this.plugin.store.settings.agentWorkMode === "readonly"
          ? tf("readonly 模式拒绝写入：操作 {operation} 不被允许", { operation })
          : tf("操作 {operation} 未被允许", { operation });
      this.plugin.store.logDiagnostic("security", message);
      throw new ApiError("OPERATION_DENIED", message, 403);
    }
  }

  public assertPathAllowed(path: string, operation: AgentOperation): void {
    this.assertOperation(operation);
    this.assertAllowed(path);
    const settings = this.plugin.store.settings;
    if (!isPathAllowedByMode(path, settings)) {
      const message = tf("访问被拒绝：{path} 不在白名单目录内", { path });
      this.plugin.store.logDiagnostic("security", message);
      throw new ApiError("FORBIDDEN", message, 403);
    }
    // 写操作也必须遵守禁止标签：目标文件存在时检查其标签。
    if (operation !== "read" && this.deniedTags().length > 0) {
      const file = this.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && this.hasDeniedTag(file)) {
        const message = tf("写入被拒绝：{path} 带有禁止访问的标签", { path });
        this.plugin.store.logDiagnostic("security", message);
        throw new ApiError("FORBIDDEN", message, 403);
      }
    }
  }

  isAllowedByMode(path: string): boolean {
    return isPathAllowedByMode(path, this.plugin.store.settings);
  }

  // -------------------------------------------------------------------------
  // confirm 工作模式：写路径挂起为待审草稿（权限检查 → confirm 拦截 → 快照 → 落盘）
  // -------------------------------------------------------------------------


  cacheTags(file: TFile): string[] {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const tags = new Set<string>();
    for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ""));
    const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const frontmatterTags = frontmatter.tags ?? frontmatter.tag;
    if (Array.isArray(frontmatterTags)) {
      for (const tag of frontmatterTags) tags.add(String(tag).replace(/^#/, ""));
    } else if (typeof frontmatterTags === "string") {
      for (const tag of frontmatterTags.split(/[,，\s]+/).filter(Boolean)) {
        tags.add(tag.replace(/^#/, ""));
      }
    }
    return [...tags];
  }

  hasDeniedTag(file: TFile): boolean {
    const denied = this.deniedTags();
    return denied.length > 0 && this.cacheTags(file).some((tag) => denied.includes(tag));
  }

  /** 列出笔记。folder 为空表示整个库。 */
  listNotes(folder = "", limit = 50): NoteSummary[] {
    return noteQueryMethods.listNotes.call(this, folder, limit);
  }

  /** 全文搜索，返回命中片段。 */
  async searchNotes(query: string, limit = 10): Promise<SearchResult[]> {
    return noteQueryMethods.searchNotes.call(this, query, limit);
  }

  /** 读取笔记全文。 */
  async readNote(path: string): Promise<{ path: string; content: string }> {
    return noteQueryMethods.readNote.call(this, path);
  }

  /** 新建、覆盖或追加笔记。confirm 档挂起为待审写入（bypassConfirm 仅采纳重放时使用）。 */
  async writeNote(
    path: string,
    content: string,
    mode: "create" | "overwrite" | "append" = "create",
    bypassConfirm = false,
    meta?: WriteMeta
  ): Promise<{ path: string; pending?: true; pendingId?: string; message?: string }> {
    return noteWriteMethods.writeNote.call(this, path, content, mode, bypassConfirm, meta);
  }

  /** 记一条速记，写入当天日记。confirm 档挂起为待审写入（预览为条目摘要）。 */
  async addMemo(
    text: string,
    tags: string[] = [],
    sourcePath?: string,
    sourceLine?: number,
    bypassConfirm = false,
    meta?: WriteMeta
  ): Promise<WithPending<MemoRecord | null>> {
    return noteWriteMethods.addMemo.call(this, text, tags, sourcePath, sourceLine, bypassConfirm, meta);
  }

  /** 最近若干天的完整指标。 */
  getStats(days = 30): Array<DayRecord & { date: string }> {
    return queryMethods.getStats.call(this, days);
  }

  /** 今日快照，口径与看板一致。 */
  getToday(): TodaySnapshot {
    return queryMethods.getToday.call(this);
  }

  /** 当前打开的笔记、选中文本与光标所在段落。 */
  getActiveContext(): {
    file: string | null;
    selection: string;
    cursorLine: number;
    cursorParagraph: string;
  } {
    return queryMethods.getActiveContext.call(this);
  }

  /** 语义检索：TF-IDF 模式纯本地离线；embedding 模式仅访问本机回环 Ollama，不可用时自动回退 TF-IDF。 */
  async semanticSearch(query: string, limit = 10): Promise<Array<{ path: string; score: number; snippet: string }>> {
    return queryMethods.semanticSearch.call(this, query, limit);
  }

  /** 只读元数据，不返回正文，节省 Agent 的 Token。 */
  async getNoteMetadata(path: string): Promise<{
    path: string;
    frontmatter: Record<string, unknown>;
    tags: string[];
    headings: string[];
    links: string[];
  }> {
    return noteQueryMethods.getNoteMetadata.call(this, path);
  }

  /** 1-hop 图谱：出链、反链与同标签笔记。 */
  getGraphNeighbors(
    path: string,
    include: string[] = ["outgoing", "backlinks", "tags"]
  ): { path: string; outgoing: string[]; backlinks: string[]; sameTag: string[] } {
    return noteQueryMethods.getGraphNeighbors.call(this, path, include);
  }

  /** 按标题或文本片段局部修改笔记；支持 dryRun、乐观锁、快照与 diff 统计。confirm 档挂起为待审写入。 */
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
  }, bypassConfirm = false, meta?: WriteMeta): Promise<{
    path: string;
    version: string;
    mtime: number;
    snapshotId?: string;
    diffSummary: { addedLines: number; removedLines: number };
    previewDiff?: string;
    createdHeading?: boolean;
    pending?: true;
    pendingId?: string;
    message?: string;
  }> {
    return patchMethods.patchNote.call(this, input, bypassConfirm, meta);
  }

  /** 单独更新 frontmatter 字段，不动正文。confirm 档挂起为待审写入。 */
  async updateFrontmatter(
    path: string,
    updates: Record<string, unknown>,
    ifMatch?: string,
    bypassConfirm = false,
    meta?: WriteMeta
  ): Promise<{ path: string; version: string; pending?: true; pendingId?: string; message?: string }> {
    return patchMethods.updateFrontmatter.call(this, path, updates, ifMatch, bypassConfirm, meta);
  }

  logToolCall(tool: string, agent: string, path: string): ToolCallRecord {
    return queryMethods.logToolCall.call(this, tool, agent, path);
  }

  getToolActivity(): {
    total: number;
    byTool: Record<string, number>;
    byAgent: Record<string, number>;
    recent: Array<{ time: string; tool: string; agent: string; path: string }>;
  } {
    return queryMethods.getToolActivity.call(this);
  }

  /** 变更时间线：合并调用流水、待审写入、审批决定与快照。只读。 */
  getChangeTimeline(limit = 50, agent?: string, path?: string) {
    return queryMethods.getChangeTimeline.call(this, limit, agent, path);
  }

  categories(): string[] {
    return listCategories(this.plugin.store.settings.knowledgeCategories);
  }

  /** 知识库分类及各分类下的笔记数。 */
  getCategories(): { categories: string[]; counts: Record<string, number> } {
    return queryMethods.getCategories.call(this);
  }

  /** 根据标题、标签和正文关键词推断分类；Agent 也可自行指定任意分类名。 */
  inferCategory(title: string, content: string, tags: string[]): string {
    return inferCategory(title, content, tags, this.categories());
  }

  async listTasks(scope = "all"): Promise<Array<{ path: string; line: number; text: string; date: string; checked: boolean }>> {
    return taskMethods.listTasks.call(this, scope);
  }

  async completeTask(path: string, line: number, bypassConfirm = false, meta?: WriteMeta): Promise<WithPending<{ ok: true }>> {
    return taskMethods.completeTask.call(this, path, line, bypassConfirm, meta);
  }

  async delegateTask(path: string, line: number, bypassConfirm = false, meta?: WriteMeta): Promise<WithPending<{ id: string }>> {
    return taskMethods.delegateTask.call(this, path, line, bypassConfirm, meta);
  }

  async snapshotTasks(bypassConfirm = false, meta?: WriteMeta): Promise<WithPending<{ count: number }>> {
    return taskMethods.snapshotTasks.call(this, bypassConfirm, meta);
  }

  /** 最近 Agent 变更及其快照 id。 */
  getAgentChanges(limit = 20): Array<{
    id: string;
    path: string;
    time: string;
    tool: string;
    agent: string;
  }> {
    return queryMethods.getAgentChanges.call(this, limit);
  }

  async revertAgentChange(snapshotId: string): Promise<{ path: string; reverted: true }> {
    return queryMethods.revertAgentChange.call(this, snapshotId);
  }

  getPomodoro(): PomodoroState {
    return queryMethods.getPomodoro.call(this);
  }

  controlPomodoro(action: string): PomodoroState {
    return queryMethods.controlPomodoro.call(this, action);
  }

  getMemos(limit = 20): MemoRecord[] {
    return queryMethods.getMemos.call(this, limit);
  }

  getBacklog(): { count: number } {
    return queryMethods.getBacklog.call(this);
  }

  /**
   * 记录一次 Agent 工作会话。同时写入 agent-logs/YYYY-MM-DD.md 与 data.json，
   * 让每天的工作过程成为可检索的沉淀。
   */
  async recordWorkLog(input: WorkLogInput, bypassConfirm = false, meta?: WriteMeta): Promise<WithPending<WorkLogRecord>> {
    return knowledgeMethods.recordWorkLog.call(this, input, bypassConfirm, meta);
  }

  /** 把一段知识沉淀成带 frontmatter 的独立笔记。confirm 档挂起为待审写入。 */
  async addKnowledge(
    input: KnowledgeInput,
    bypassConfirm = false,
    meta?: WriteMeta
  ): Promise<{ path: string; note?: string; pending?: true; pendingId?: string; message?: string }> {
    return knowledgeMethods.addKnowledge.call(this, input, bypassConfirm, meta);
  }

  /** 最近 N 天的工作日志。 */
  listWorkLogs(days = 7): WorkLogRecord[] {
    return queryMethods.listWorkLogs.call(this, days);
  }

  /** 智能体开工时一次拿全需要的上下文。 */
  getDailyContext(days = 7): DailyContext {
    return queryMethods.getDailyContext.call(this, days);
  }

  /** 认领一条 #to-agent 任务，避免被重复处理。 */
  async claimAgentTask(id: string, bypassAccess = false, meta?: WriteMeta): Promise<MemoRecord | AgentPendingResult> {
    return taskMethods.claimAgentTask.call(this, id, bypassAccess, meta);
  }

  /** 完成任务：标记为 #agent-done，可关联产出笔记。 */
  async completeAgentTask(id: string, resultPath?: string, bypassAccess = false, meta?: WriteMeta): Promise<MemoRecord | AgentPendingResult> {
    return taskMethods.completeAgentTask.call(this, id, resultPath, bypassAccess, meta);
  }

  /** 生成周复盘 Markdown（不落盘）。 */
  generateWeeklyReview(date?: string): { date: string; markdown: string } {
    return queryMethods.generateWeeklyReview.call(this, date);
  }

  // 审核队列：显式委托到 api-review.ts，保持对外 API 不变，避免类/接口合并告警。
  isConfirmMode(): boolean {
    return reviewMethods.isConfirmMode.call(this);
  }

  holdForConfirm(
    tool: string,
    path: string,
    kind: string,
    args: Record<string, unknown>,
    before: string,
    after: string,
    meta: WriteMeta = {}
  ): AgentPendingResult {
    return reviewMethods.holdForConfirm.call(this, tool, path, kind, args, before, after, meta);
  }

  listPendingWrites(limit = 50) {
    return reviewMethods.listPendingWrites.call(this, limit);
  }

  getPendingWrite(id: string): PendingWriteRecord | null {
    return reviewMethods.getPendingWrite.call(this, id);
  }

  settlePendingCall(record: PendingWriteRecord, landed: boolean): void {
    reviewMethods.settlePendingCall.call(this, record, landed);
  }

  assertPendingUnchanged(record: PendingWriteRecord): Promise<void> {
    return reviewMethods.assertPendingUnchanged.call(this, record);
  }

  approvePendingWrite(id: string): Promise<{ path: string }> {
    return reviewMethods.approvePendingWrite.call(this, id);
  }

  rejectPendingWrite(id: string): { ok: true; path: string } {
    return reviewMethods.rejectPendingWrite.call(this, id);
  }

  importBridgeProposal(proposal: BridgeProposal): Promise<{ pendingId: string; path: string }> {
    return reviewMethods.importBridgeProposal.call(this, proposal);
  }

  replayPending(request: PendingWriteRecord["request"], agent = ""): Promise<void> {
    return reviewMethods.replayPending.call(this, request, agent);
  }
}
