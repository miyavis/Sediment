import { TFile, type Vault } from "obsidian";
import { fileExists, fileMtimeMs, listDirectory, readTextFile } from "../utils/node";
import { vaultGetFullPath } from "../utils/vault";
import type { SedimentPlugin } from "../main";

function backupDirectory(vault: Vault): string | null {
  return vaultGetFullPath(vault, `${vault.configDir}/plugins/sediment/backups`);
}

export interface BackupInfo {
  name: string;
  mtimeMs: number;
}

/** 一次目录列举拿到多个笔记的快照，供审核列表批量使用（避免逐行同步 IO）。 */
export function listBackupsMap(plugin: SedimentPlugin, paths: string[]): Map<string, BackupInfo[]> {
  const map = new Map<string, BackupInfo[]>(paths.map((path) => [path, []]));
  const directory = backupDirectory(plugin.app.vault);
  if (!directory || !fileExists(directory)) return map;
  const entries = listDirectory(directory).map((name) => ({
    name,
    mtimeMs: fileMtimeMs(`${directory}/${name}`).mtimeMs,
  }));
  for (const path of paths) {
    const suffix = path.replace(/[\\/]/g, "_");
    map.set(
      path,
      entries.filter((entry) => entry.name.endsWith(suffix)).sort((a, b) => b.mtimeMs - a.mtimeMs)
    );
  }
  return map;
}

/** 列出某个笔记在插件 backups 目录里的历史快照。 */
export function listBackups(plugin: SedimentPlugin, path: string): BackupInfo[] {
  return listBackupsMap(plugin, [path]).get(path) ?? [];
}

/** 快照名校验：快照 id 形如 `<时间戳>-<笔记路径>`，路径可含中文、空格与常见标点。
 *  只拒绝会逃逸 backups 目录的字符（路径分隔符、`..`、NUL/控制字符），不限制为 ASCII。
 *  旧版 `/^[A-Za-z0-9._-]+$/` 会把中文笔记的快照误判为非法，导致差异对比读到空串
 *  （左栏空白、全部算新增行），且恢复时抛「非法快照文件名」。 */
function isValidBackupName(name: string): boolean {
  if (!name || name === "." || name.includes("..")) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    // 47='/' 92='\' 为路径分隔符；<32 与 127 为控制字符/NUL。
    if (code === 47 || code === 92 || code < 32 || code === 127) return false;
  }
  return true;
}

export function readBackup(plugin: SedimentPlugin, name: string): string {
  if (!isValidBackupName(name)) return "";
  const directory = backupDirectory(plugin.app.vault);
  if (!directory) return "";
  return readTextFile(`${directory}/${name}`, "utf8");
}

export async function restoreBackup(
  plugin: SedimentPlugin,
  file: TFile,
  name: string
): Promise<void> {
  if (!isValidBackupName(name)) {
    throw new Error(`非法快照文件名：${name}`);
  }
  const directory = backupDirectory(plugin.app.vault);
  // 快照文件可能已被保留策略清理；此时绝不能把笔记覆盖成空内容。
  if (!directory || !fileExists(`${directory}/${name}`)) {
    throw new Error(`快照文件不存在或已被清理：${name}`);
  }
  const content = readBackup(plugin, name);
  await plugin.app.vault.process(file, () => content);
}
