import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { TFile, type Vault } from "obsidian";
import type { SedimentPlugin } from "../main";

function backupDirectory(vault: Vault): string | null {
  const adapter = vault.adapter as unknown as { getFullPath?: (path: string) => string };
  return adapter.getFullPath?.(`${vault.configDir}/plugins/sediment/backups`) ?? null;
}

export interface BackupInfo {
  name: string;
  mtimeMs: number;
}

/** 列出某个笔记在插件 backups 目录里的历史快照。 */
export function listBackups(plugin: SedimentPlugin, path: string): BackupInfo[] {
  const directory = backupDirectory(plugin.app.vault);
  if (!directory || !existsSync(directory)) return [];
  const suffix = path.replace(/[\\/]/g, "_");
  return readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .map((name) => ({ name, mtimeMs: statSync(`${directory}/${name}`).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readBackup(plugin: SedimentPlugin, name: string): string {
  const directory = backupDirectory(plugin.app.vault);
  if (!directory) return "";
  return readFileSync(`${directory}/${name}`, "utf8");
}

export async function restoreBackup(
  plugin: SedimentPlugin,
  file: TFile,
  name: string
): Promise<void> {
  const directory = backupDirectory(plugin.app.vault);
  // 快照文件可能已被保留策略清理；此时绝不能把笔记覆盖成空内容。
  if (!directory || !existsSync(`${directory}/${name}`)) {
    throw new Error(`快照文件不存在或已被清理：${name}`);
  }
  const content = readBackup(plugin, name);
  await plugin.app.vault.process(file, () => content);
}
