import type { Plugin } from "obsidian";
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
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

/** 包装 Obsidian 的 loadData/saveData，提供按天读写与防抖保存。 */
export class Store {
  data: PulseData = DEFAULT_DATA;
  migrationWarning: string | null = null;
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
    const loaded = raw && typeof raw === "object" ? (raw as Partial<PulseData>) : {};
    let recoveryPath = "";
    if (raw && typeof raw === "object") {
      const version = (raw as Partial<PulseData>).version;
      if (typeof version !== "number" || version !== 1) {
        this.persistenceBlocked = true;
        this.migrationWarning = typeof version === "number"
          ? `不支持的数据版本 ${version}，已暂停写入以保护原始数据`
          : "数据缺少有效版本号，已暂停写入以保护原始数据";
        recoveryPath = await this.preserveRecoveryCopy(raw);
      }
    } else if (raw != null) {
      this.persistenceBlocked = true;
      this.migrationWarning = "数据格式异常，已暂停写入以保护原始数据";
      recoveryPath = await this.preserveRecoveryCopy(raw);
    }
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
      pendingWrites: Array.isArray(loaded.pendingWrites)
        ? (loaded.pendingWrites as PendingWriteRecord[]).filter(
            (item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.path === "string"
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
    if (this.migrationWarning) {
      this.logDiagnostic(
        "migration",
        this.migrationWarning,
        recoveryPath ? `恢复副本：${recoveryPath}` : "恢复副本创建失败",
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
    await this.plugin.saveData(this.data);
    void this.backupData();
  }

  /** 把 data.json 快照写入库内普通文件夹，按设置保留最近若干份。 */
  async backupData(force = false): Promise<number> {
    if (!this.data.settings.backupEnabled && !force) return 0;
    const now = Date.now();
    if (!force && now - this.lastBackupAt < 3_600_000) return 0;
    this.lastBackupAt = now;

    const folder = normalizeFolder(this.data.settings.backupFolder || "sediment-backup");
    try {
      await ensureFolder(this.plugin.app.vault, folder);
      const date = new Date();
      const stamp = `${dateKey(date)}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
      const path = folder ? `${folder}/data-${stamp}.json` : `data-${stamp}.json`;
      await this.plugin.app.vault.adapter.write(path, JSON.stringify(this.data, null, 2));

      const keep = Math.max(1, this.data.settings.backupKeep);
      const backups = this.plugin.app.vault
        .getFiles()
        .filter((file) => file.extension === "json" && file.basename.startsWith("data-") &&
          (!folder || file.path.startsWith(`${folder}/`)))
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
      for (const old of backups.slice(keep)) await this.plugin.app.vault.trash(old, false);
      return 1;
    } catch (error) {
      return 0;
    }
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
