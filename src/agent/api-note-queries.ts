/** AgentApi 的笔记只读查询方法（列表/搜索/读取全文/元数据/图谱）。
 *  混入到 AgentApi 原型，对外 API 不变；依赖的门禁助手均为公开成员。 */

import { TFile } from "obsidian";
import { t, tf } from "../i18n";
import { normalizeFolder } from "../utils/vault";
import { ApiError, safeAgentPath } from "./api";
import type { AgentApi, NoteSummary, SearchResult } from "./api";

export interface NoteQueryMethods {
  listNotes(folder?: string, limit?: number): NoteSummary[];
  searchNotes(query: string, limit?: number): Promise<SearchResult[]>;
  readNote(path: string): Promise<{ path: string; content: string }>;
  getNoteMetadata(path: string): Promise<{
    path: string;
    frontmatter: Record<string, unknown>;
    tags: string[];
    headings: string[];
    links: string[];
  }>;
  getGraphNeighbors(
    path: string,
    include?: string[]
  ): { path: string; outgoing: string[]; backlinks: string[]; sameTag: string[] };
}

export const noteQueryMethods: NoteQueryMethods = {
  listNotes(this: AgentApi, folder = "", limit = 50): NoteSummary[] {
    const prefix = normalizeFolder(folder).toLowerCase();
    return this.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          (!prefix || file.path.toLowerCase().startsWith(`${prefix}/`)) &&
          this.isAllowedByMode(file.path) &&
          !this.hasDeniedTag(file)
      )
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map((file) => ({ path: file.path, title: file.basename, folder: file.parent?.path ?? "/" }));
  },

  async searchNotes(this: AgentApi, query: string, limit = 10): Promise<SearchResult[]> {
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return [];
    const results: SearchResult[] = [];
    for (const file of this.vault.getMarkdownFiles()) {
      if (results.length >= Math.max(1, Math.min(limit, 100))) break;
      if (!this.isAllowedByMode(file.path) || this.hasDeniedTag(file)) continue;
      const text = await this.vault.cachedRead(file);
      const position = text.toLowerCase().indexOf(needle);
      if (position < 0) continue;
      const start = Math.max(0, position - 60);
      const end = Math.min(text.length, position + needle.length + 160);
      results.push({
        path: file.path,
        title: file.basename,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
        matchType: "exact",
        matchSource: "body",
        kind: "note",
      });
    }

    const cap = Math.max(1, Math.min(limit, 100));
    for (const memo of this.plugin.store.data.memos) {
      if (results.length >= cap) break;
      if (!memo.text.toLowerCase().includes(needle)) continue;
      results.push({
        path: "",
        title: tf("速记 {date} {time}", { date: memo.date, time: memo.time }),
        snippet: memo.text.slice(0, 220),
        matchType: "exact",
        matchSource: "memo",
        kind: "memo",
      });
    }
    for (const log of this.plugin.store.data.workLogs) {
      if (results.length >= cap) break;
      const haystack = `${log.task} ${log.summary} ${log.learnings ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      results.push({
        path: "",
        title: tf("工作日志 {date} {time} · {agent}", { date: log.date, time: log.time, agent: log.agent }),
        snippet: `${log.task} — ${log.summary}`.slice(0, 220),
        matchType: "exact",
        matchSource: "worklog",
        kind: "worklog",
      });
    }
    for (const file of this.vault.getMarkdownFiles()) {
      if (results.length >= cap) break;
      if (!this.isAllowedByMode(file.path) || this.hasDeniedTag(file)) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.sediment_status !== "draft") continue;
      if (!file.basename.toLowerCase().includes(needle)) continue;
      results.push({
        path: file.path,
        title: file.basename,
        snippet: t("待审核的知识草稿"),
        matchType: "exact",
        matchSource: "title",
        kind: "draft",
      });
    }
    return results;
  },

  async readNote(this: AgentApi, path: string): Promise<{ path: string; content: string }> {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    if (this.hasDeniedTag(file)) throw new Error(`访问被拒绝：${safe} 带有禁止访问的标签`);
    return { path: safe, content: await this.vault.read(file) };
  },

  async getNoteMetadata(this: AgentApi, path: string) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    return {
      path: safe,
      frontmatter: cache?.frontmatter ?? {},
      tags: this.cacheTags(file),
      headings: (cache?.headings ?? []).map((heading) => `${"#".repeat(heading.level)} ${heading.heading}`),
      links: (cache?.links ?? []).map((link) => link.link),
    };
  },

  getGraphNeighbors(this: AgentApi, path: string, include: string[] = ["outgoing", "backlinks", "tags"]) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "read");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    const resolved = this.plugin.app.metadataCache.resolvedLinks ?? {};
    const allowed = (target: string): boolean => !this.isDeniedPath(target) && target !== safe;
    const outgoing = include.includes("outgoing") ? Object.keys(resolved[safe] ?? {}).filter(allowed) : [];
    const backlinks = include.includes("backlinks")
      ? Object.entries(resolved)
          .filter(([source, links]) => allowed(source) && Object.prototype.hasOwnProperty.call(links, safe))
          .map(([source]) => source)
      : [];
    let sameTag: string[] = [];
    if (include.includes("tags")) {
      const targetTags = new Set(this.cacheTags(file));
      sameTag = this.vault
        .getMarkdownFiles()
        .filter((other) => allowed(other.path) && !this.hasDeniedTag(other))
        .filter((other) => this.cacheTags(other).some((tag) => targetTags.has(tag)))
        .map((other) => other.path);
    }
    return { path: safe, outgoing, backlinks, sameTag };
  },
};
