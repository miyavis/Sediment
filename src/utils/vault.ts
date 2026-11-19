import type { Vault } from "obsidian";

/** 去掉路径首尾多余的斜杠，并合并重复斜杠。 */
export function normalizeFolder(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
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
        // 并发创建时目录可能已被其它流程建好，忽略即可。
        if (!vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
}
