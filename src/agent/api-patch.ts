/** AgentApi 的局部修改方法（patch_note / update_frontmatter）。
 *  混入到 AgentApi 原型，对外 API 不变；乐观锁、快照、confirm 挂起复用类的公开方法。 */

import { TFile } from "obsidian";
import { countWords } from "../tracker";
import { safeAgentPath } from "./api";
import { ApiError } from "./errors";
import { applyFrontmatterUpdate, findSection, lineChanges, simpleDiff, versionOf } from "./api-helpers";
import type { AgentApi, WriteMeta } from "./api";

interface PatchInput {
  path: string;
  heading?: string;
  find?: string;
  content: string;
  mode?: "replace" | "append" | "prepend";
  operation?: "append_under_heading" | "prepend_under_heading" | "replace_block" | "update_frontmatter";
  index?: number;
  ifMatch?: string;
  expectedMtime?: number;
  dryRun?: boolean;
}

interface PatchResult {
  path: string;
  version: string;
  mtime: number;
  snapshotId?: string;
  diffSummary: { addedLines: number; removedLines: number };
  previewDiff?: string;
  createdHeading?: boolean;
  pending?: true;
  pendingId?: string;
  message?: string;
}

export interface PatchMethods {
  patchNote(input: PatchInput, bypassConfirm?: boolean, meta?: WriteMeta): Promise<PatchResult>;
  updateFrontmatter(
    path: string,
    updates: Record<string, unknown>,
    ifMatch?: string,
    bypassConfirm?: boolean,
    meta?: WriteMeta
  ): Promise<{ path: string; version: string; pending?: true; pendingId?: string; message?: string }>;
}

export const patchMethods: PatchMethods = {
  async patchNote(this: AgentApi, input, bypassConfirm = false, meta?: WriteMeta) {
    const safe = safeAgentPath(input.path, this.vault.configDir);
    this.assertPathAllowed(safe, "patch");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new ApiError("NOT_FOUND", `笔记不存在：${safe}`, 404);
    const before = await this.vault.read(file);

    if (typeof input.expectedMtime === "number" && input.expectedMtime !== file.stat.mtime) {
      throw new ApiError("VERSION_CONFLICT", `文件已被修改：${safe}，请重新读取后再写入`, 409);
    }
    if (input.ifMatch && versionOf(before) !== input.ifMatch) {
      throw new ApiError("VERSION_CONFLICT", `版本冲突：${safe} 已被修改，请重新读取后再写入`, 409);
    }

    if (input.operation === "update_frontmatter") {
      let updates: Record<string, unknown>;
      try {
        updates = JSON.parse(String(input.content ?? "{}")) as Record<string, unknown>;
      } catch {
        throw new ApiError("INVALID_JSON", "update_frontmatter 的 content 必须是 JSON 对象字符串");
      }
      const result = await this.updateFrontmatter(safe, updates, input.ifMatch, bypassConfirm, meta);
      return { ...result, mtime: file.stat.mtime, diffSummary: { addedLines: 0, removedLines: 0 } };
    }

    const content = String(input.content ?? "");
    const mode = input.operation === "append_under_heading" ? "append"
      : input.operation === "prepend_under_heading" ? "prepend"
      : input.mode ?? "replace";
    let createdHeading = false;
    let result = "";

    if (input.find) {
      const positions: number[] = [];
      let from = 0;
      for (;;) {
        const at = before.indexOf(input.find, from);
        if (at < 0) break;
        positions.push(at);
        from = at + input.find.length;
      }
      if (positions.length > 1 && input.index === undefined) {
        throw new ApiError("AMBIGUOUS_MATCH", `文本片段在文中出现 ${positions.length} 次，请提供更多上下文或指定 index`);
      }
      const position = positions[input.index ?? 0];
      if (position === undefined) throw new ApiError("NOT_FOUND", `未找到文本片段：${input.find}`, 404);
      result = before.slice(0, position) + content + before.slice(position + input.find.length);
    } else if (input.heading) {
      const section = findSection(before, input.heading, input.index ?? 0);
      if (!section) {
        createdHeading = true;
        result = `${before.trimEnd()}\n\n${input.heading}\n${content}\n`;
      } else {
        const body = section.lines.slice(section.start, section.end);
        const incoming = content.split("\n");
        const nextBody = mode === "replace" ? incoming : mode === "append" ? [...body, "", ...incoming] : [...incoming, "", ...body];
        result = [...section.lines.slice(0, section.start), ...nextBody, ...section.lines.slice(section.end)].join("\n");
      }
    } else {
      throw new ApiError("MISSING_ANCHOR", "patch_note 需要 heading 或 find 参数");
    }

    const diffSummary = lineChanges(before, result);
    if (input.dryRun) {
      return { path: safe, version: versionOf(result), mtime: file.stat.mtime, diffSummary, previewDiff: simpleDiff(before, result), createdHeading };
    }

    if (!bypassConfirm && (meta?.hold || this.isConfirmMode())) {
      return {
        ...this.holdForConfirm("patch_note", safe, "patch_note", { input }, before, result, meta),
        path: safe, version: versionOf(result), mtime: file.stat.mtime, diffSummary, createdHeading,
      };
    }

    const snapshotId = this.backupNote(safe, before, meta);
    this.plugin.tracker.markAgentWrite(safe);
    await this.vault.process(file, () => result);
    this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => { day.aiWordsAdded += countWords(content); });
    return { path: safe, version: versionOf(result), mtime: file.stat.mtime, snapshotId: snapshotId || undefined, diffSummary, createdHeading };
  },

  async updateFrontmatter(this: AgentApi, path, updates, ifMatch?, bypassConfirm = false, meta?: WriteMeta) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, "patch");
    const file = this.vault.getAbstractFileByPath(safe);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${safe}`);
    const before = await this.vault.read(file);
    if (ifMatch && versionOf(before) !== ifMatch) {
      throw new Error(`版本冲突：${safe} 已被修改，请重新读取后再写入`);
    }
    const result = applyFrontmatterUpdate(before, updates);
    if (!bypassConfirm && (meta?.hold || this.isConfirmMode())) {
      return {
        ...this.holdForConfirm("frontmatter", safe, "frontmatter", { path: safe, updates, ifMatch }, before, result, meta),
        path: safe, version: versionOf(result),
      };
    }
    this.backupNote(safe, before, meta);
    this.plugin.tracker.markAgentWrite(safe);
    await this.vault.process(file, () => result);
    return { path: safe, version: versionOf(result) };
  },
};
