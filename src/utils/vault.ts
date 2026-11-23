import type { Vault } from "obsidian";
import type { PulseSettings } from "../types";

/** 去掉路径首尾多余的斜杠，并合并重复斜杠。 */
export function normalizeFolder(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

/** 插件自身产出的四个目录（日记/复盘/工作日志/备份），归一化后去空。 */
export function pluginOwnedFolders(settings: PulseSettings): string[] {
  return [
    settings.dailyNoteFolder,
    settings.reviewFolder,
    settings.workLogFolder,
    settings.backupFolder,
  ]
    .map((folder) => normalizeFolder(String(folder ?? "")))
    .filter((folder) => folder.length > 0);
}

/** 路径是否位于给定目录集合内（相等子路径）。 */
export function isPathInFolders(path: string, folders: string[]): boolean {
  return folders.some((folder) => path.startsWith(`${folder}/`));
}

/** 取 vault 内相对路径的绝对磁盘路径；adapter 不支持时返回 null。 */
export function vaultGetFullPath(vault: Vault, relative: string): string | null {
  const adapter = vault.adapter as unknown as { getFullPath?: (path: string) => string };
  return adapter.getFullPath?.(relative) ?? null;
}

/** 逐级创建目录（已存在则跳过）。 */
export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const folder = normalizeFolder(path);
  if (!folder) return;
  let current = "";
  for (const part of folder.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) {
      try {
        await vault.createFolder(current);
      } catch (error) {
        // 并发创建或元数据缓存滞后时目录可能已存在；两种信号都视为成功。
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(message)) continue;
        if (!vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
}

/** metadataCache.frontmatter 的类型是 any；只接受对象，否则视为无 frontmatter。 */
export function frontmatterOf(cache: { frontmatter?: unknown } | null | undefined): Record<string, unknown> | undefined {
  const value = cache?.frontmatter;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
