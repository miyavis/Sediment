import { Notice, TFile, type Plugin } from "obsidian";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  type DayRecord,
  type DiagnosticRecord,
  type FocusSessionRecord,
  type FolderMigrationRecord,
  type MemoRecord,
  type PendingWriteRecord,
  type PulseData,
  type PulseSettings,
  type SnapshotRecord,
  type ToolCallRecord,
  type WorkLogRecord,
  type WriteDecisionRecord,
} from "../types";
import { t, tf } from "../i18n";
import { reconcilePendingWrites, markStaleByPaths } from "../agent/reconcile";
import { rebuildAgentUsage, recordAgentUsage, sanitizeAgentUsage } from "./agent-usage";
import { redactSecrets } from "../agent/security";
import { dateKey } from "../utils/dates";
import { contentHash } from "../utils/hash";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import { logError } from "../utils/log-error";

/** 诊断日志保留上限：超出后丢弃最旧记录。诊断弹窗按此上限提示「还有更多」。 */
export const DIAGNOSTICS_CAP = 300;

/** 弹窗窗口兼容：Obsidian 环境用 activeWindow.setTimeout；纯 Node 测试环境回退到顶层 setTimeout。 */
const nodeSetTimeout: (fn: () => void, ms: number) => unknown =
  typeof activeWindow === "undefined" ? setTimeout : activeWindow.setTimeout.bind(activeWindow);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    nodeSetTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function validMemo(value: unknown): value is import("../types").MemoRecord {
  if (!isRecord(value)) return false;
  return (
    isStr(value.id) && isStr(value.date) && isStr(value.text) &&
    Array.isArray(value.tags) && value.tags.every(isStr) && typeof value.converted === "boolean"
  );
}

function validWorkLog(value: unknown): value is WorkLogRecord {
  if (!isRecord(value)) return false;
  return isStr(value.id) && isStr(value.date) && isStr(value.time) && isStr(value.agent) && isStr(value.task);
}

function validSnapshot(value: unknown): value is SnapshotRecord {
  if (!isRecord(value)) return false;
  return isStr(value.id) && isStr(value.path) && isStr(value.time);
}

function validToolCall(value: unknown): value is ToolCallRecord {
  if (!isRecord(value)) return false;
  return isStr(value.time) && isStr(value.tool) && isStr(value.agent) && isStr(value.path);
}

function validDiagnostic(value: unknown): value is DiagnosticRecord {
  if (!isRecord(value)) return false;
  return isStr(value.time) && isStr(value.message) && isStr(value.category);
}

function validWriteDecision(value: unknown): value is WriteDecisionRecord {
  if (!isRecord(value)) return false;
  return (
    isStr(value.id) && isStr(value.time) && isStr(value.pendingId) &&
    (value.decision === "approved" || value.decision === "rejected" || value.decision === "stale") &&
    isStr(value.tool) && isStr(value.agent) && isStr(value.path)
  );
}

/** 过滤数组中的畸形元素，避免损坏 data.json 让下游 .includes/.split 抛 TypeError。 */
function onlyValid<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : [];
}

/** 旧版迁移记录形状校验：异常数据回退为 null，不阻断其它数据加载。 */
function normalizeFolderMigration(value: unknown): FolderMigrationRecord | null {
  if (!isRecord(value)) return null;
  const at = value.at;
  const items = value.items;
  if (typeof at !== "string" || !Array.isArray(items)) return null;
  const validItems = items.filter(
    (item): item is FolderMigrationRecord["items"][number] =>
      isRecord(item) &&
      typeof item.key === "string" &&
      typeof item.from === "string" &&
      typeof item.to === "string"
  );
  if (validItems.length !== items.length) return null;
  const before = value.dailyNotesFolderBefore;
  return {
    at,
    items: validItems,
    ...(typeof before === "string" ? { dailyNotesFolderBefore: before } : {}),
  };
}

/** 字段存在但类型/形状异常视为结构损坏；缺失或 null 走默认值补齐，不算损坏。 */
function corruptFields(loaded: Partial<PulseData>): string[] {
  const recordKeys = ["days", "reviewedChanges", "editSessions", "settings", "pomodoro"] as const;
  const arrayKeys = ["memos", "workLogs", "toolCalls", "snapshots", "diagnostics", "focusSessions", "pendingWrites"] as const;
  const corrupt: string[] = [];
  for (const key of recordKeys) {
    const value = loaded[key];
    if (value != null && !isRecord(value)) corrupt.push(key);
  }
  for (const key of arrayKeys) {
    const value = loaded[key];
    if (value != null && !Array.isArray(value)) corrupt.push(key);
  }
  return corrupt;
}

/** data.json 备份条目（供恢复 UI 使用）。 */
export interface DataBackupInfo {
  /** 备份文件名（不含目录），如 data-2026-11-20-0830.json */
  name: string;
  /** 备份写入时间（毫秒时间戳，取文件 mtime） */
  savedAt: number;
  /** 文件字节数 */
  size: number;
}

/** restoreDataBackup 的结果：区分「副本已保存 / 无当前数据 / 副本写入失败」。 */
export interface RestoreBackupResult {
  /** 恢复副本路径；未创建副本时为空串。 */
  recoveryPath: string;
  /** saved=副本已写入；none=全新安装无当前数据可备份；failed=副本写入失败。 */
  recovery: "saved" | "none" | "failed";
}

/** 包装 Obsidian 的 loadData/saveData，提供按天读写与防抖保存。 */
export class Store {
  data: PulseData = DEFAULT_DATA;
  migrationWarning: string | null = null;
  /** 最近一次 load/restore 保留的恢复副本路径（阻塞写入时供 Notice 展示）。 */
  recoveryCopyPath: string | null = null;
  private persistenceBlocked = false;
  private saveTimer: number | null = null;
  /** 保存与备份串行链：避免并发 save/backup/restore 互相覆盖。 */
  private saveChain: Promise<void> = Promise.resolve();
  private backupChain: Promise<number> = Promise.resolve(0);
  private lastBackupAt = 0;
  /** 保存失败 Notice 节流：持续失败时 60s 内同类只弹一次，避免刷屏。 */
  private lastSaveNoticeAt = 0;

  constructor(private plugin: Plugin) {}

  /** 用当前令牌脱敏：令牌可能出现在 Agent 可控的诊断消息/工具路径里，禁止明文落盘。 */
  private redact(text: string): string {
    const token = this.data.settings?.agentServerToken;
    return token ? redactSecrets(text, [token]) : text;
  }

  /** 记录可在真实环境查看的诊断事件；默认同时安排一次保存。 */
  logDiagnostic(
    category: DiagnosticRecord["category"],
    message: string,
    detail?: string,
    schedule = true
  ): void {
    if (!this.data.settings?.diagnosticsEnabled) return;
    this.data.diagnostics ??= [];
    this.data.diagnostics.unshift({
      time: new Date().toISOString(),
      category,
      message: this.redact(message),
      detail: detail === undefined ? undefined : this.redact(detail),
    });
    if (this.data.diagnostics.length > DIAGNOSTICS_CAP) this.data.diagnostics.length = DIAGNOSTICS_CAP;
    if (schedule) this.scheduleSave(2000);
  }

  private async preserveRecoveryCopy(raw: unknown): Promise<string> {
    try {
      const adapter = this.plugin.app?.vault?.adapter;
      if (!adapter?.write) return "";
      const recoveryDir = `${this.plugin.app.vault.configDir}/plugins/sediment/recovery`;
      await ensureFolder(this.plugin.app.vault, recoveryDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `${recoveryDir}/data-${stamp}.json`;
      await adapter.write(path, JSON.stringify(raw, null, 2));
      return path;
    } catch (error) {
      logError(this, "恢复副本创建失败", error);
      return "";
    }
  }

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as unknown;
    const loaded = isRecord(raw) ? (raw as Partial<PulseData>) : {};
    let recoveryPath = "";
    let migratedVersion = false;
    if (isRecord(raw)) {
      const version = loaded.version;
      const corrupt = corruptFields(loaded);
      if (version === undefined && corrupt.length === 0) {
        // 旧数据无版本号：形状符合 v1 时补齐 version 并写回，失败才阻塞。
        try {
          await this.plugin.saveData({ ...raw, version: 1 });
          loaded.version = 1;
          migratedVersion = true;
        } catch (error) {
          logError(this, "数据版本号写回失败", error, "migration");
          this.persistenceBlocked = true;
          this.migrationWarning = t("数据版本号迁移失败，已暂停写入以保护原始数据");
          recoveryPath = await this.preserveRecoveryCopy(raw);
        }
      } else if (typeof version !== "number" || version !== 1) {
        this.persistenceBlocked = true;
        this.migrationWarning = typeof version === "number"
          ? tf("不支持的数据版本 {version}，已暂停写入以保护原始数据", { version })
          : t("数据缺少有效版本号，已暂停写入以保护原始数据");
        recoveryPath = await this.preserveRecoveryCopy(raw);
      } else if (corrupt.length > 0) {
        // 结构性损坏与版本守卫走同一条保护路径：保留恢复副本并阻塞写入。
        this.persistenceBlocked = true;
        this.migrationWarning = tf("数据结构损坏（{fields}），已暂停写入以保护原始数据", {
          fields: corrupt.join(", "),
        });
        recoveryPath = await this.preserveRecoveryCopy(raw);
      }
    } else if (raw != null) {
      this.persistenceBlocked = true;
      this.migrationWarning = t("数据格式异常，已暂停写入以保护原始数据");
      recoveryPath = await this.preserveRecoveryCopy(raw);
    }
    this.recoveryCopyPath = recoveryPath || null;
    this.data = {
      version: loaded.version ?? 1,
      days: loaded.days && typeof loaded.days === "object" && !Array.isArray(loaded.days) ? loaded.days : {},
      memos: onlyValid(loaded.memos, validMemo),
      workLogs: onlyValid(loaded.workLogs, validWorkLog),
      toolCalls: onlyValid(loaded.toolCalls, validToolCall),
      agentUsage: {},
      snapshots: onlyValid(loaded.snapshots, validSnapshot),
      reviewedChanges:
        loaded.reviewedChanges && typeof loaded.reviewedChanges === "object" && !Array.isArray(loaded.reviewedChanges)
          ? loaded.reviewedChanges
          : {},
      // 旧版 data.json 没有该字段时默认空数组，保证升级兼容。
      // 缺 request.kind 或 request.args 形状异常的畸形条目会让 approvePendingWrite
      // 抛裸 TypeError（HTTP 500），迁移时一并过滤。
      pendingWrites: Array.isArray(loaded.pendingWrites)
        ? loaded.pendingWrites.filter(
            (item) =>
              item &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.path === "string" &&
              item.request &&
              typeof item.request === "object" &&
              typeof item.request.kind === "string" &&
              isRecord(item.request.args)
          )
        : [],
      writeDecisions: onlyValid(loaded.writeDecisions, validWriteDecision),
      diagnostics: onlyValid(loaded.diagnostics, validDiagnostic),
      editSessions: loaded.editSessions && typeof loaded.editSessions === "object" && !Array.isArray(loaded.editSessions)
        ? loaded.editSessions
        : {},
      folderMigration: normalizeFolderMigration(loaded.folderMigration),
      focusSessions: Array.isArray(loaded.focusSessions) ? loaded.focusSessions : [],
      pomodoro: loaded.pomodoro ?? null,
      settings: { ...DEFAULT_SETTINGS, ...(loaded.settings && typeof loaded.settings === "object" ? loaded.settings : {}) },
    };

    // 聚合字段是后加的：缺失/形状异常，或字段为空但流水已有记录时，按现有流水重建。
    // 流水本身最多 500 条，更早的历史无法补回，这是升级时的一次性近似。
    const usage = sanitizeAgentUsage(loaded.agentUsage);
    this.data.agentUsage =
      usage && (Object.keys(usage).length > 0 || this.data.toolCalls.length === 0)
        ? usage
        : rebuildAgentUsage(this.data.toolCalls);

    if (migratedVersion) {
      this.logDiagnostic("migration", "已自动补齐数据版本号 v1", undefined, false);
    }
    if (this.migrationWarning) {
      this.logDiagnostic(
        "migration",
        this.migrationWarning,
        recoveryPath ? tf("恢复副本：{path}", { path: recoveryPath }) : t("恢复副本创建失败"),
        false
      );
    }

    // 编辑会话去重表只保留最近两天，避免无限增长。
    const keepSince = dateKey(new Date(Date.now() - 86400000));
    for (const key of Object.keys(this.data.editSessions)) {
      if (key < keepSince) delete this.data.editSessions[key];
    }
    for (const key of Object.keys(this.data.days)) {
      const day = { ...createEmptyDay(), ...this.data.days[key] };
      day.hourlyWords = Array.from({ length: 24 }, (_, hour) => Number(day.hourlyWords?.[hour]) || 0);
      day.folderWords = day.folderWords ?? {};
      day.wordsAdded = Math.max(0, Math.round(day.wordsAdded));
      day.wordsRemoved = Math.max(0, Math.round(day.wordsRemoved));
      day.edits = Math.max(0, Math.round(day.edits));
      day.notesCreated = Math.max(0, Math.round(day.notesCreated));
      day.tasksCompleted = Math.max(0, Math.round(day.tasksCompleted));
      day.focusMinutes = Math.max(0, Math.round(day.focusMinutes));
      day.activeMinutes = Math.max(0, Math.round(day.activeMinutes));
      day.capturedWords = Math.max(0, Math.round(day.capturedWords));
      day.aiWordsAdded = Math.max(0, Math.round(day.aiWordsAdded));
      day.contribution = computeContribution(day, this.data.settings);
      this.data.days[key] = day;
    }
  }

  /** 权重或封顶变更后，按当前设置全量重算历史贡献分。 */
  recomputeContributions(): void {
    for (const key of Object.keys(this.data.days)) {
      this.data.days[key].contribution = computeContribution(this.data.days[key], this.settings);
    }
    this.scheduleSave();
  }

  private cancelSaveTimer(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** 只等待在途 IO 落地，不额外保存当前内存态（恢复前调用：旧数据反正要被替换）。 */
  private async waitForIdleIO(): Promise<void> {
    this.cancelSaveTimer();
    await this.saveChain;
    await this.backupChain;
  }

  /** 卸载前冲刷：把当前内存态作为最后一次保存入队，再等待全部 IO 结束。 */
  async flush(): Promise<void> {
    this.cancelSaveTimer();
    await this.save();
    await this.backupChain;
  }

  async save(): Promise<void> {
    if (this.persistenceBlocked) return;
    this.cancelSaveTimer();
    const next = this.saveChain.then(() => this.persistWithRetry());
    // 保存失败不向调用方抛错（沿用旧语义），但失败链不能阻塞后续保存。
    this.saveChain = next.catch(() => {});
    return next;
  }

  /** 实际写盘：失败退避重试 3 次；成功后再触发一次自动备份。 */
  private async persistWithRetry(): Promise<void> {
    if (this.persistenceBlocked) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.plugin.saveData(this.data);
        void this.backupData().catch((error) => {
          logError(this, "自动备份失败", error);
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(120 * 2 ** attempt);
      }
    }
    logError(this, "保存 data.json 失败", lastError);
    const now = Date.now();
    if (now - this.lastSaveNoticeAt >= 60_000) {
      this.lastSaveNoticeAt = now;
      new Notice(t("数据保存失败，请检查磁盘空间或文件权限"));
    }
  }

  /** 把 data.json 快照写入库内普通文件夹，按设置保留最近若干份。失败向调用方抛错。 */
  async backupData(force = false): Promise<number> {
    const next = this.backupChain.then(() => this.performBackup(force));
    this.backupChain = next.catch(() => 0);
    return next;
  }

  private async performBackup(force: boolean): Promise<number> {
    if (!this.data.settings.backupEnabled && !force) return 0;
    const now = Date.now();
    if (!force && now - this.lastBackupAt < 3_600_000) return 0;

    const folder = normalizeFolder(this.data.settings.backupFolder);
    await ensureFolder(this.plugin.app.vault, folder);
    const date = new Date();
    // 毫秒 + 随机后缀：并发/同分钟内多次备份不写同名文件，避免互相覆盖。
    const stamp = `${dateKey(date)}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}-${String(date.getMilliseconds()).padStart(3, "0")}-${Math.random().toString(36).slice(2, 6)}`;
    const path = folder ? `${folder}/data-${stamp}.json` : `data-${stamp}.json`;
    await this.plugin.app.vault.adapter.write(path, JSON.stringify(this.data, null, 2));
    this.lastBackupAt = now;

    // 备份目录为库根目录（或空串）时只备份不清理，避免误删用户自有的 data-*.json 文件。
    if (!folder) return 1;
    const keep = Math.max(1, this.data.settings.backupKeep);
    // 计数滞后说明：vault.getFiles() 读的是元数据缓存，可能尚未收录刚 adapter.write 的新快照，
    // 于是本轮 slice(keep) 少删一份，磁盘短暂保留 keep+1 份；下一次备份缓存追上后即收敛回 keep。
    // 这是「宁可多留一份、绝不误删」的有意取舍，不做激进的 keep-1 预扣（缓存若已收录反而会少留）。
    const backups = this.plugin.app.vault
      .getFiles()
      .filter((file) => file.extension === "json" && file.basename.startsWith("data-") &&
        file.path.startsWith(`${folder}/`) && !file.path.slice(folder.length + 1).includes("/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    for (const old of backups.slice(keep)) await this.plugin.app.fileManager.trashFile(old);
    return 1;
  }

  /** 列出备份目录中的 data.json 快照，按时间倒序（供恢复 UI 使用）。 */
  listDataBackups(): DataBackupInfo[] {
    const folder = normalizeFolder(this.data.settings.backupFolder);
    return this.plugin.app.vault
      .getFiles()
      .filter((file) => file.extension === "json" && file.basename.startsWith("data-") &&
        (folder
          ? file.path.startsWith(`${folder}/`) && !file.path.slice(folder.length + 1).includes("/")
          : !file.path.includes("/")))
      .map((file) => ({ name: file.name, savedAt: file.stat.mtime, size: file.stat.size }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * 从备份恢复 data.json：先把当前 data.json 存为恢复副本，再写回备份内容并重载内存态。
   * 返回 { recoveryPath, recovery }：recovery 区分副本已保存 / 无当前数据 / 副本写入失败，
   * 全新安装（无 data.json）不再被误报为「恢复副本创建失败」。
   * 文件名非法（含路径穿越）或备份损坏时抛错。
   */
  async restoreDataBackup(name: string): Promise<RestoreBackupResult> {
    // 恢复前先让在途保存/备份落地，否则旧数据可能覆盖刚恢复的备份。
    await this.waitForIdleIO();
    if (!/^data-[A-Za-z0-9._-]+\.json$/.test(name) || name.includes("..")) {
      throw new Error(t("备份文件名不合法"));
    }
    const folder = normalizeFolder(this.data.settings.backupFolder);
    const path = folder ? `${folder}/${name}` : name;
    if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
      throw new Error(tf("备份不存在或已被清理：{name}", { name }));
    }
    const content = await this.plugin.app.vault.adapter.read(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(tf("备份内容损坏，无法恢复：{name}", { name }));
    }
    const candidate = parsed as Partial<PulseData>;
    if (!isRecord(parsed) || corruptFields(candidate).length > 0 ||
      (candidate.version != null && candidate.version !== 1)) {
      throw new Error(tf("备份内容损坏，无法恢复：{name}", { name }));
    }
    // 恢复前保留当前 data.json，恢复错了也能回退。
    const currentRaw = (await this.plugin.loadData()) as unknown;
    let recoveryPath = "";
    let recovery: RestoreBackupResult["recovery"] = "none";
    if (currentRaw != null) {
      recoveryPath = await this.preserveRecoveryCopy(currentRaw);
      recovery = recoveryPath ? "saved" : "failed";
    }
    await this.plugin.saveData({ ...candidate, version: 1 });
    this.persistenceBlocked = false;
    this.migrationWarning = null;
    this.recoveryCopyPath = null;
    await this.load();
    return { recoveryPath, recovery };
  }

  /** 写入是否因数据保护被暂停（恢复 UI 可据此提示）。 */
  get isPersistenceBlocked(): boolean {
    return this.persistenceBlocked;
  }

  scheduleSave(delay = 800): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delay);
  }

  get settings(): PulseSettings {
    return this.data.settings;
  }

  todayKey(): string {
    return dateKey(new Date());
  }

  getDay(key: string): DayRecord {
    return { ...createEmptyDay(), ...(this.data.days[key] ?? {}) };
  }

  ensureDay(key: string): DayRecord {
    let day = this.data.days[key];
    if (!day) {
      day = createEmptyDay();
      this.data.days[key] = day;
    }
    return day;
  }

  updateDay(key: string, mutate: (day: DayRecord) => void): DayRecord {
    const day = this.ensureDay(key);
    mutate(day);
    day.wordsAdded = Math.max(0, Math.round(day.wordsAdded));
    day.wordsRemoved = Math.max(0, Math.round(day.wordsRemoved));
    day.edits = Math.max(0, Math.round(day.edits));
    day.notesCreated = Math.max(0, Math.round(day.notesCreated));
    day.tasksCompleted = Math.max(0, Math.round(day.tasksCompleted));
    day.focusMinutes = Math.max(0, Math.round(day.focusMinutes));
    day.contribution = computeContribution(day, this.settings);
    this.scheduleSave();
    return day;
  }

  addMemo(memo: MemoRecord): void {
    this.data.memos.unshift(memo);
    if (this.data.memos.length > 2000) this.data.memos.length = 2000;
    this.scheduleSave();
  }

  addWorkLog(log: WorkLogRecord): void {
    this.data.workLogs.unshift(log);
    if (this.data.workLogs.length > 500) this.data.workLogs.length = 500;
    this.scheduleSave();
  }

  /** 记录一次调用；返回记录本身，供 confirm 档随后标记为挂起。
   *  countUsage=false 用于采纳补记，避免同一次请求在客户端调用统计里算两次。 */
  logToolCall(record: ToolCallRecord, countUsage = true): ToolCallRecord {
    if (record.path) record.path = this.redact(record.path);
    this.data.toolCalls.unshift(record);
    if (this.data.toolCalls.length > 500) this.data.toolCalls.length = 500;
    if (countUsage) recordAgentUsage(this.data.agentUsage, record.agent, record.time, record.tool);
    this.scheduleSave(2000);
    return record;
  }

  /** 把当前请求的调用标记为挂起中：它还没落盘，不能进变更审查。 */
  markToolCallHeld(call: ToolCallRecord | null, pendingId: string): void {
    if (!call) return;
    call.held = true;
    call.pendingId = pendingId;
    this.scheduleSave(2000);
  }

  /** 采纳后让原调用进入变更审查（去掉 held）；返回是否命中挂起记录。 */
  releaseToolCall(pendingId: string): boolean {
    const call = this.data.toolCalls.find((item) => item.pendingId === pendingId && item.held);
    if (!call) return false;
    delete call.held;
    this.scheduleSave(2000);
    return true;
  }

  /** 移除一次写请求的调用流水（鉴权/参数/路由失败时不留审计行）。按引用匹配。 */
  dropToolCall(call: ToolCallRecord): void {
    const index = this.data.toolCalls.indexOf(call);
    if (index >= 0) this.data.toolCalls.splice(index, 1);
  }

  /** 驳回后移除从未落盘的调用记录，避免留下「目标已删除」的幽灵审计行。 */
  dropPendingToolCall(pendingId: string): boolean {
    const index = this.data.toolCalls.findIndex(
      (item) => item.pendingId === pendingId && item.held
    );
    if (index < 0) return false;
    this.data.toolCalls.splice(index, 1);
    this.scheduleSave(2000);
    return true;
  }

  reviewChange(key: string, decision: "kept" | "reverted"): void {
    this.data.reviewedChanges[key] = { decision, time: new Date().toISOString() };
    this.logDiagnostic("storage", `Agent 变更已审查：${decision}`, key);
    this.scheduleSave();
  }

  /** 永久记录一次待审写入的人工决定，供变更时间线审计（含驳回）。 */
  recordWriteDecision(
    record: { id: string; tool: string; agent: string; path: string },
    decision: WriteDecisionRecord["decision"],
    reason?: string
  ): void {
    this.data.writeDecisions ??= [];
    this.data.writeDecisions.unshift({
      id: `decision:${record.id}:${decision}`,
      time: new Date().toISOString(),
      pendingId: record.id,
      decision,
      tool: record.tool,
      agent: record.agent,
      path: record.path,
      ...(reason ? { reason } : {}),
    });
    if (this.data.writeDecisions.length > 500) this.data.writeDecisions.length = 500;
    this.scheduleSave();
  }

  /** 挂起一条 confirm 模式的待审写入；超出上限时丢弃最旧的条目。 */
  addPendingWrite(record: PendingWriteRecord): void {
    this.data.pendingWrites.unshift(record);
    if (this.data.pendingWrites.length > 100) this.data.pendingWrites.length = 100;
    this.scheduleSave(2000);
  }

  /** 按 id 移除挂起项并返回被移除的记录（找不到返回 undefined）。 */
  removePendingWrite(id: string): PendingWriteRecord | undefined {
    const index = this.data.pendingWrites.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [removed] = this.data.pendingWrites.splice(index, 1);
    this.scheduleSave(2000);
    return removed;
  }

  /** 启动对账：目标已不存在的待审写入标记 stale，返回新标记数。 */
  reconcilePending(exists: (path: string) => boolean): number {
    const marked = reconcilePendingWrites(this.data.pendingWrites, exists);
    if (marked > 0) this.scheduleSave(2000);
    return marked;
  }

  /** 删除/重命名事件即时标记失效待审项。 */
  markPendingWritesStale(paths: string[]): number {
    const marked = markStaleByPaths(this.data.pendingWrites, paths);
    if (marked > 0) this.scheduleSave(2000);
    return marked;
  }

  /** 修改事件：挂起后目标内容被改（或新建目标被抢先创建）→ 标记失效，
   *  与 approvePendingWrite 的哈希复验同一口径，避免批准旧预览落盘新内容。 */
  async markPendingWritesChanged(paths: string[]): Promise<number> {
    const targets = new Set(paths);
    let marked = 0;
    for (const record of this.data.pendingWrites ?? []) {
      if (record.stale || !targets.has(record.path)) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(record.path);
      if (record.expectAbsent) {
        if (file instanceof TFile) {
          record.stale = true;
          marked += 1;
        }
        continue;
      }
      // 条目式写入没有全文快照，内容变动不据此失效（仍由删除/重命名事件处理）。
      if (record.before === "") continue;
      if (!(file instanceof TFile)) {
        record.stale = true;
        marked += 1;
        continue;
      }
      if (record.beforeHash) {
        const current = await this.plugin.app.vault.read(file);
        if (contentHash(current) !== record.beforeHash) {
          record.stale = true;
          marked += 1;
        }
      }
    }
    if (marked > 0) this.scheduleSave(2000);
    return marked;
  }

  addSnapshot(record: SnapshotRecord): void {
    this.data.snapshots.unshift(record);
    if (this.data.snapshots.length > 200) this.data.snapshots.length = 200;
    this.scheduleSave(2000);
  }

  addFocusSession(record: FocusSessionRecord): void {
    this.data.focusSessions.unshift(record);
    if (this.data.focusSessions.length > 500) this.data.focusSessions.length = 500;
    this.scheduleSave();
  }
}
