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
