import { Notice, type Plugin } from "obsidian";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  type DayRecord,
  type DiagnosticRecord,
  type FocusSessionRecord,
  type MemoRecord,
  type PendingWriteRecord,
  type PulseData,
  type PulseSettings,
  type SnapshotRecord,
  type ToolCallRecord,
  type WorkLogRecord,
} from "../types";
import { t, tf } from "../i18n";
import { reconcilePendingWrites, markStaleByPaths } from "../agent/reconcile";
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import { logError } from "../utils/log-error";

/** 诊断日志保留上限：超出后丢弃最旧记录。诊断弹窗按此上限提示「还有更多」。 */
export const DIAGNOSTICS_CAP = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  private lastBackupAt = 0;
  /** 保存失败 Notice 节流：持续失败时 60s 内同类只弹一次，避免刷屏。 */
  private lastSaveNoticeAt = 0;

  constructor(private plugin: Plugin) {}

  /** 记录可在真实环境查看的诊断事件；默认同时安排一次保存。 */
  logDiagnostic(
    category: DiagnosticRecord["category"],
    message: string,
    detail?: string,
    schedule = true
  ): void {
    if (!this.data.settings?.diagnosticsEnabled) return;
    this.data.diagnostics ??= [];
    this.data.diagnostics.unshift({ time: new Date().toISOString(), category, message, detail });
    if (this.data.diagnostics.length > DIAGNOSTICS_CAP) this.data.diagnostics.length = DIAGNOSTICS_CAP;
    if (schedule) this.scheduleSave(2000);
  }

  private async preserveRecoveryCopy(raw: unknown): Promise<string> {
    try {
      const adapter = this.plugin.app?.vault?.adapter;
      if (!adapter?.write) return "";
      await ensureFolder(this.plugin.app.vault, ".obsidian/plugins/sediment/recovery");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `.obsidian/plugins/sediment/recovery/data-${stamp}.json`;
      await adapter.write(path, JSON.stringify(raw, null, 2));
      return path;
    } catch (error) {
      logError(this, "恢复副本创建失败", error);
      return "";
    }
  }

  async load(): Promise<void> {
    const raw = await this.plugin.loadData();
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
      memos: Array.isArray(loaded.memos) ? loaded.memos : [],
      workLogs: Array.isArray(loaded.workLogs) ? loaded.workLogs : [],
      toolCalls: Array.isArray(loaded.toolCalls) ? loaded.toolCalls : [],
      snapshots: Array.isArray(loaded.snapshots) ? loaded.snapshots : [],
      reviewedChanges:
        loaded.reviewedChanges && typeof loaded.reviewedChanges === "object" && !Array.isArray(loaded.reviewedChanges)
          ? (loaded.reviewedChanges as Record<string, "kept" | "reverted">)
          : {},
      // 旧版 data.json 没有该字段时默认空数组，保证升级兼容。
      // 缺 request.kind 或 request.args 形状异常的畸形条目会让 approvePendingWrite
      // 抛裸 TypeError（HTTP 500），迁移时一并过滤。
      pendingWrites: Array.isArray(loaded.pendingWrites)
        ? (loaded.pendingWrites as PendingWriteRecord[]).filter(
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
      diagnostics: Array.isArray(loaded.diagnostics) ? loaded.diagnostics : [],
      editSessions: loaded.editSessions && typeof loaded.editSessions === "object" && !Array.isArray(loaded.editSessions)
        ? loaded.editSessions
        : {},
      focusSessions: Array.isArray(loaded.focusSessions) ? loaded.focusSessions : [],
      pomodoro: loaded.pomodoro ?? null,
      settings: { ...DEFAULT_SETTINGS, ...(loaded.settings && typeof loaded.settings === "object" ? loaded.settings : {}) },
    };
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

  async save(): Promise<void> {
    if (this.persistenceBlocked) return;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.plugin.saveData(this.data);
    } catch (error) {
      logError(this, "保存 data.json 失败", error);
      const now = Date.now();
      if (now - this.lastSaveNoticeAt >= 60_000) {
        this.lastSaveNoticeAt = now;
        new Notice(t("数据保存失败，请检查磁盘空间或文件权限"));
      }
      return;
    }
    void this.backupData().catch((error) => {
      logError(this, "自动备份失败", error);
    });
  }

  /** 把 data.json 快照写入库内普通文件夹，按设置保留最近若干份。失败向调用方抛错。 */
  async backupData(force = false): Promise<number> {
    if (!this.data.settings.backupEnabled && !force) return 0;
    const now = Date.now();
    if (!force && now - this.lastBackupAt < 3_600_000) return 0;

    const folder = normalizeFolder(this.data.settings.backupFolder);
    await ensureFolder(this.plugin.app.vault, folder);
    const date = new Date();
    const stamp = `${dateKey(date)}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
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
    for (const old of backups.slice(keep)) await this.plugin.app.vault.trash(old, false);
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
    const currentRaw = await this.plugin.loadData();
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

  logToolCall(record: ToolCallRecord): void {
    this.data.toolCalls.unshift(record);
    if (this.data.toolCalls.length > 500) this.data.toolCalls.length = 500;
    this.scheduleSave(2000);
  }

  reviewChange(key: string, decision: "kept" | "reverted"): void {
    this.data.reviewedChanges[key] = decision;
    this.logDiagnostic("storage", `Agent 变更已审查：${decision}`, key);
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
