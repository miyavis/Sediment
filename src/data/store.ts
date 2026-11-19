import type { Plugin } from "obsidian";
import {
  computeContribution,
  createEmptyDay,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  type DayRecord,
  type MemoRecord,
  type PulseData,
  type PulseSettings,
  type ToolCallRecord,
  type WorkLogRecord,
} from "../types";
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

/** 包装 Obsidian 的 loadData/saveData，提供按天读写与防抖保存。 */
export class Store {
  data: PulseData = DEFAULT_DATA;
  private saveTimer: number | null = null;
  private lastBackupAt = 0;

  constructor(private plugin: Plugin) {}

  async load(): Promise<void> {
    const raw = await this.plugin.loadData();
    const loaded = raw && typeof raw === "object" ? (raw as Partial<PulseData>) : {};
    this.data = {
      version: loaded.version ?? 1,
      days: loaded.days ?? {},
      memos: loaded.memos ?? [],
      workLogs: loaded.workLogs ?? [],
      toolCalls: loaded.toolCalls ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(loaded.settings ?? {}) },
    };
    for (const key of Object.keys(this.data.days)) {
      const day = { ...createEmptyDay(), ...this.data.days[key] };
      day.hourlyWords = Array.from({ length: 24 }, (_, hour) => Number(day.hourlyWords?.[hour]) || 0);
      day.folderWords = day.folderWords ?? {};
      day.activeMinutes = Math.max(0, Math.round(day.activeMinutes));
      day.capturedWords = Math.max(0, Math.round(day.capturedWords));
      day.aiWordsAdded = Math.max(0, Math.round(day.aiWordsAdded));
      day.contribution = computeContribution(day);
      this.data.days[key] = day;
    }
  }

  async save(): Promise<void> {
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
    day.contribution = computeContribution(day);
    this.scheduleSave();
    return day;
  }

  addMemo(memo: MemoRecord): void {
    this.data.memos.unshift(memo);
    this.scheduleSave();
  }

  addWorkLog(log: WorkLogRecord): void {
    this.data.workLogs.unshift(log);
    this.scheduleSave();
  }

  logToolCall(record: ToolCallRecord): void {
    this.data.toolCalls.unshift(record);
    if (this.data.toolCalls.length > 500) this.data.toolCalls.length = 500;
    this.scheduleSave(2000);
  }
}
