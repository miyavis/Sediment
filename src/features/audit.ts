import { TFile, type Vault } from "obsidian";
import type { SedimentPlugin } from "../main";

interface FsModule {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: string): string;
  statSync(path: string): { mtimeMs: number };
}

function nodeFs(): FsModule | null {
  try {
    return require("fs") as FsModule;
  } catch (error) {
    return null;
  }
}

function backupDirectory(vault: Vault): string | null {
  const adapter = vault.adapter as unknown as { getFullPath?: (path: string) => string };
  return adapter.getFullPath?.(".obsidian/plugins/sediment/backups") ?? null;
}

export interface BackupInfo {
  name: string;
  mtimeMs: number;
}

/** 列出某个笔记在插件 backups 目录里的历史快照。 */
export function listBackups(plugin: SedimentPlugin, path: string): BackupInfo[] {
  const fs = nodeFs();
  const directory = backupDirectory(plugin.app.vault);
  if (!fs || !directory || !fs.existsSync(directory)) return [];
  const suffix = path.replace(/[\\/]/g, "_");
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .map((name) => ({ name, mtimeMs: fs.statSync(`${directory}/${name}`).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readBackup(plugin: SedimentPlugin, name: string): string {
  const fs = nodeFs();
  const directory = backupDirectory(plugin.app.vault);
  if (!fs || !directory) return "";
  return fs.readFileSync(`${directory}/${name}`, "utf8");
}

export async function restoreBackup(
  plugin: SedimentPlugin,
  file: TFile,
  name: string
): Promise<void> {
  const content = readBackup(plugin, name);
  await plugin.app.vault.process(file, () => content);
}
