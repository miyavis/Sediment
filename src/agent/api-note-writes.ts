/** AgentApi 的笔记写方法（write_note / add_memo）。
 *  混入到 AgentApi 原型，对外 API 不变；confirm 挂起、门禁与快照复用类的公开方法。 */

import { TFile } from "obsidian";
import { tf } from "../i18n";
import { countWords } from "../tracker";
import { dateKey, dailyNotePath } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import { safeAgentPath } from "./api";
import { stampAgentProvenance } from "./api-helpers";
import type { AgentApi, WithPending, WriteMeta } from "./api";
import type { MemoRecord } from "../types";

export interface NoteWriteMethods {
  writeNote(
    path: string,
    content: string,
    mode?: "create" | "overwrite" | "append",
    bypassConfirm?: boolean,
    meta?: WriteMeta
  ): Promise<{ path: string; pending?: true; pendingId?: string; message?: string }>;
  addMemo(
    text: string,
    tags?: string[],
    sourcePath?: string,
    sourceLine?: number,
    bypassConfirm?: boolean,
    meta?: WriteMeta
  ): Promise<WithPending<MemoRecord | null>>;
}

export const noteWriteMethods: NoteWriteMethods = {
  async writeNote(this: AgentApi, path, content, mode = "create", bypassConfirm = false, meta?: WriteMeta) {
    const safe = safeAgentPath(path, this.vault.configDir);
    this.assertPathAllowed(safe, mode === "overwrite" ? "overwrite" : mode === "append" ? "patch" : "create");
    const folder = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
    const existing = this.vault.getAbstractFileByPath(safe);
    if (mode === "create" && existing) throw new Error(`笔记已存在：${safe}`);

    const knowledgeBase = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    const finalContent =
      mode === "create" && knowledgeBase.length > 0 && safe.startsWith(`${knowledgeBase}/`)
        ? stampAgentProvenance(content, meta?.agent || "agent", dateKey(new Date()))
        : content;

    if (!bypassConfirm && (meta?.hold || this.isConfirmMode())) {
      const previous = existing instanceof TFile ? await this.vault.read(existing) : "";
      const after = mode === "append" && existing instanceof TFile
        ? `${previous.trimEnd()}\n\n${finalContent}`
        : finalContent;
      return {
        ...this.holdForConfirm("write_note", safe, "write_note", { path: safe, content: finalContent, mode }, previous, after, meta),
        path: safe,
      };
    }

    await ensureFolder(this.vault, folder);
    this.plugin.tracker.markAgentWrite(safe);
    if (mode === "append" && existing instanceof TFile) {
      const previous = await this.vault.read(existing);
      this.backupNote(safe, previous, meta);
      await this.vault.modify(existing, `${previous.trimEnd()}\n\n${finalContent}`);
    } else if (existing instanceof TFile) {
      const previous = await this.vault.read(existing);
      this.backupNote(safe, previous, meta);
      await this.vault.modify(existing, finalContent);
    } else {
      await this.vault.create(safe, finalContent);
    }
    this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => {
      day.aiWordsAdded += countWords(content);
    });
    return { path: safe };
  },

  async addMemo(this: AgentApi, text, tags = [], sourcePath?, sourceLine?, bypassConfirm = false, meta?: WriteMeta) {
    const daily = dailyNotePath(this.plugin.store.settings, new Date());
    const dailyExists = this.vault.getAbstractFileByPath(daily) instanceof TFile;
    this.assertPathAllowed(daily, dailyExists ? "patch" : "create");
    if (!bypassConfirm && this.isConfirmMode()) {
      const tagStr = tags.length ? `\n标签：${tags.map((tag) => `#${String(tag).replace(/^#/, "")}`).join(" ")}` : "";
      return this.holdForConfirm(
        "add_memo", daily, "memo", { text, tags, sourcePath, sourceLine }, "",
        tf("记一条速记到 {path}", { path: daily }) + `\n${String(text ?? "").trim()}${tagStr}`, meta
      );
    }
    return this.plugin.memos.add(
      text, tags, sourcePath ? { path: sourcePath, line: sourceLine ?? 1 } : undefined
    );
  },
};
