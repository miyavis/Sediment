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
  type PulseData,
  type PulseSettings,
  type SnapshotRecord,
  type ToolCallRecord,
  type WorkLogRecord,
} from "../types";
import { t, tf } from "../i18n";
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 字段存在但类型/形状异常视为结构损坏；缺失或 null 走默认值补齐，不算损坏。 */
function corruptFields(loaded: Partial<PulseData>): string[] {
  const recordKeys = ["days", "reviewedChanges", "editSessions", "settings", "pomodoro"] as const;
  const arrayKeys = ["memos", "workLogs", "toolCalls", "snapshots", "diagnostics", "focusSessions"] as const;
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

/** 包装 Obsidian 的 loadData/saveData，提供按天读写与防抖保存。 */
export class Store {
  data: PulseData = DEFAULT_DATA;
  migrationWarning: string | null = null;
  /** 最近一次 load/restore 保留的恢复副本路径（阻塞写入时供 Notice 展示）。 */
  recoveryCopyPath: string | null = null;
  private persistenceBlocked = false;
  private saveTimer: number | null = null;
  private lastBackupAt = 0;

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
    if (this.data.diagnostics.length > 300) this.data.diagnostics.length = 300;
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
    } catch {
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
          console.error("Sediment: 数据版本号写回失败", error);
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
      console.error("Sediment: 保存 data.json 失败", error);
      new Notice(t("数据保存失败，请检查磁盘空间或文件权限"));
      return;
    }
    void this.backupData().catch((error) => {
      console.error("Sediment: 自动备份失败", error);
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
   * 返回恢复副本路径（创建失败时为空串）。文件名非法（含路径穿越）或备份损坏时抛错。
   */
  async restoreDataBackup(name: string): Promise<string> {
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
    const recoveryPath = currentRaw != null ? await this.preserveRecoveryCopy(currentRaw) : "";
    await this.plugin.saveData({ ...candidate, version: 1 });
    this.persistenceBlocked = false;
    this.migrationWarning = null;
    this.recoveryCopyPath = null;
    await this.load();
    return recoveryPath;
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
