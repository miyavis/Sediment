/** 旧版默认目录（daily / reviews / …）一次性收进 Sediment/ 的迁移执行器。
 *  只迁移「仍然是旧默认值」的目录，用户自定义过的路径一律不动；
 *  冲突目录整体跳过、移动失败逐文件回滚，设置仅在整目录成功后更新。 */

import { tf } from "../i18n";
import type { PulseSettings } from "../types";
import { normalizeFolder } from "../utils/vault";

export type FolderMigrationKey =
  | "dailyNoteFolder"
  | "reviewFolder"
  | "workLogFolder"
  | "knowledgeFolder"
  | "backupFolder";

export interface FolderMigrationPlanItem {
  key: FolderMigrationKey;
  /** 旧默认目录（库内相对路径，已归一化） */
  from: string;
  /** 新默认目录 */
  to: string;
}

/** 五个默认目录的旧值 → 新值。顺序即迁移顺序。 */
export const LEGACY_FOLDER_MIGRATIONS: readonly FolderMigrationPlanItem[] = [
  { key: "dailyNoteFolder", from: "daily", to: "Sediment/daily" },
  { key: "reviewFolder", from: "reviews", to: "Sediment/reviews" },
  { key: "workLogFolder", from: "agent-logs", to: "Sediment/agent-logs" },
  { key: "knowledgeFolder", from: "knowledge", to: "Sediment/knowledge" },
  { key: "backupFolder", from: "sediment-backup", to: "Sediment/backups" },
];

/** 仅选出设置为旧默认值的目录；自定义路径不打扰。 */
export function planFolderMigrations(settings: PulseSettings): FolderMigrationPlanItem[] {
  return LEGACY_FOLDER_MIGRATIONS.filter(
    (item) => normalizeFolder(String(settings[item.key] ?? "")) === item.from
  );
}

/** 迁移所需的最小 vault 面（真实 Vault 结构兼容，便于单测注入桩）。 */
export interface MigrationFile {
  path: string;
}

export interface MigrationVault {
  getFiles(): MigrationFile[];
  getAbstractFileByPath(path: string): unknown;
  /** 真实 Vault 提供；rename 不会代建目标父目录，移动前必须逐级创建。 */
  createFolder?(path: string): Promise<unknown>;
  adapter?: {
    list?(path: string): Promise<{ files: string[]; folders: string[] }>;
    rmdir?(path: string, recursive?: boolean): Promise<void>;
  };
}

export interface MigrationFileManager {
  renameFile(file: MigrationFile, newPath: string): Promise<void>;
}

export interface MigrateFoldersOptions {
  settings: PulseSettings;
  vault: MigrationVault;
  fileManager: MigrationFileManager;
}

export interface FolderMigrationOutcome {
  /** 已完成迁移（含源目录本就不存在、只改设置）的目录 */
  migrated: FolderMigrationPlanItem[];
  /** 因目标冲突整体跳过的目录 */
  skipped: Array<FolderMigrationPlanItem & { reason: string }>;
  /** 移动失败并已尝试回滚的目录 */
  failed: Array<FolderMigrationPlanItem & { reason: string }>;
  /** 实际移动的文件数 */
  movedFiles: number;
}

/** 目标路径已被同名普通文件占用（不再是文件夹）时，整目录无法落位。 */
function targetIsFile(vault: MigrationVault, path: string): boolean {
  const existing = vault.getAbstractFileByPath(path);
  return !!existing && !Array.isArray((existing as { children?: unknown }).children);
}

function parentFolderOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/**
 * 真实 Obsidian 的 vault.rename 直接走 fs.rename，不会创建目标父目录，缺目录即 ENOENT。
 * 移动前按层级从浅到深逐级补建（已存在则跳过）。
 */
async function ensureMigrationFolders(vault: MigrationVault, folders: string[]): Promise<void> {
  const ordered = [...new Set(folders.filter(Boolean))].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
  for (const folder of ordered) {
    if (vault.getAbstractFileByPath(folder)) continue;
    if (!vault.createFolder) throw new Error(tf("无法创建目录：{path}", { path: folder }));
    try {
      await vault.createFolder(folder);
    } catch (error) {
      // 并发创建时目录可能已被其它流程建好，忽略即可。
      if (!vault.getAbstractFileByPath(folder)) throw error;
    }
  }
}

/** 迁移后尽力清理空的源目录（含空子目录）；失败只保留原样，不影响迁移结果。 */
async function cleanupEmptySource(vault: MigrationVault, folder: string): Promise<void> {
  const adapter = vault.adapter;
  const list = adapter?.list?.bind(adapter);
  const rmdir = adapter?.rmdir?.bind(adapter);
  if (!adapter || !list || !rmdir) return;
  const removeIfEmpty = async (path: string): Promise<void> => {
    try {
      const first = await list(path);
      for (const child of first.folders ?? []) await removeIfEmpty(child);
      const fresh = await list(path);
      if ((fresh.files?.length ?? 0) === 0 && (fresh.folders?.length ?? 0) === 0) {
        await rmdir(path, false);
      }
    } catch {
      // 目录已不存在或无法清理：保留原样。
    }
  };
  await removeIfEmpty(folder);
}

/**
 * 按 LEGACY_FOLDER_MIGRATIONS 迁移旧默认目录。
 * - 目录不存在或为空：只更新设置；
 * - 目标已有同名文件 / 目标路径被文件占用：整目录跳过并给出原因；
 * - 目标父目录不存在：移动前逐级创建（Obsidian rename 不代建目录），创建失败则整目录失败；
 * - 单个文件移动失败：把已移动文件按相反顺序移回，目录设置保持旧值。
 * 设置更新只在整目录成功后发生；调用方负责保存设置与刷新界面。
 */
export async function migrateLegacyFolders(options: MigrateFoldersOptions): Promise<FolderMigrationOutcome> {
  const { settings, vault, fileManager } = options;
  const outcome: FolderMigrationOutcome = { migrated: [], skipped: [], failed: [], movedFiles: 0 };

  for (const item of planFolderMigrations(settings)) {
    if (targetIsFile(vault, item.to)) {
      outcome.skipped.push({ ...item, reason: tf("目标路径已被同名文件占用：{path}", { path: item.to }) });
      continue;
    }
    const files = vault
      .getFiles()
      .filter((file) => file.path.startsWith(`${item.from}/`))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) {
      settings[item.key] = item.to;
      outcome.migrated.push(item);
      await cleanupEmptySource(vault, item.from);
      continue;
    }

    const moves = files.map((file) => ({
      file,
      fromPath: file.path,
      toPath: `${item.to}${file.path.slice(item.from.length)}`,
    }));
    const conflicts = moves.filter((move) => vault.getAbstractFileByPath(move.toPath));
    if (conflicts.length > 0) {
      outcome.skipped.push({ ...item, reason: tf("目标已有 {n} 个同名文件", { n: conflicts.length }) });
      continue;
    }

    // 子目录也要保留：目标父目录（含 Sediment/ 本身）必须是文件夹且真实存在。
    const destinationFolders = [...new Set(moves.map((move) => parentFolderOf(move.toPath)))];
    const blockedFolder = destinationFolders.find((folder) => targetIsFile(vault, folder));
    if (blockedFolder) {
      outcome.skipped.push({ ...item, reason: tf("目标路径已被同名文件占用：{path}", { path: blockedFolder }) });
      continue;
    }
    try {
      await ensureMigrationFolders(vault, destinationFolders);
    } catch (error) {
      outcome.failed.push({
        ...item,
        reason: tf("创建目标目录失败：{error}", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      continue;
    }

    const done: typeof moves = [];
    let failure = "";
    for (const move of moves) {
      try {
        await fileManager.renameFile(move.file, move.toPath);
        done.push(move);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (failure) {
      let rollbackFailed = false;
      for (const move of [...done].reverse()) {
        try {
          await fileManager.renameFile(move.file, move.fromPath);
        } catch {
          rollbackFailed = true;
        }
      }
      outcome.failed.push({
        ...item,
        reason: rollbackFailed
          ? tf("移动失败：{error}；部分文件回滚失败，请手动检查", { error: failure })
          : tf("移动失败：{error}", { error: failure }),
      });
      continue;
    }

    settings[item.key] = item.to;
    outcome.migrated.push(item);
    outcome.movedFiles += done.length;
    await cleanupEmptySource(vault, item.from);
  }

  return outcome;
}
