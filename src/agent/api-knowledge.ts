/** AgentApi 的知识沉淀与工作日志方法。
 *  混入到 AgentApi 原型，对外 API 不变；confirm 挂起与门禁复用类的公开委托方法。 */

import { TFile } from "obsidian";
import { t, tf } from "../i18n";
import { countWords } from "../tracker";
import { dateKey, hhmm } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import { isSafePathSegmentName } from "./access";
import { ApiError, safeAgentPath } from "./api";
import type { AgentApi, KnowledgeInput, WithPending, WorkLogInput, WriteMeta } from "./api";
import type { WorkLogRecord } from "../types";

export interface KnowledgeMethods {
  recordWorkLog(input: WorkLogInput, bypassConfirm?: boolean, meta?: WriteMeta): Promise<WithPending<WorkLogRecord>>;
  addKnowledge(input: KnowledgeInput, bypassConfirm?: boolean, meta?: WriteMeta): Promise<{
    path: string;
    note?: string;
    pending?: true;
    pendingId?: string;
    message?: string;
  }>;
}

/** frontmatter 标量去换行，防止注入额外 YAML 行（3.3）。 */
function fmScalar(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export const knowledgeMethods: KnowledgeMethods = {
  async recordWorkLog(this: AgentApi, input: WorkLogInput, bypassConfirm = false, meta?: WriteMeta) {
    const now = new Date();
    const log: WorkLogRecord = {
      id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      date: dateKey(now),
      time: hhmm(now),
      agent: String(input.agent || "agent").slice(0, 40),
      task: String(input.task || "").trim(),
      summary: String(input.summary || "").trim(),
      decisions: String(input.decisions || "").trim(),
      files: Array.isArray(input.files) ? input.files.map(String) : [],
      learnings: String(input.learnings || "").trim(),
      openQuestions: String(input.openQuestions || "").trim(),
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).replace(/^#/, "")) : [],
    };
    const folder = normalizeFolder(this.plugin.store.settings.workLogFolder);
    const path = folder ? `${folder}/${log.date}.md` : `${log.date}.md`;
    const logExists = this.vault.getAbstractFileByPath(path) instanceof TFile;
    this.assertPathAllowed(path, logExists ? "patch" : "create");

    const block = [
      `## ${log.time} · ${log.agent}`,
      "",
      `> [!summary] ${t("任务")}`,
      `> ${log.task || "—"}`,
      "",
      `**${t("完成了什么")}**`,
      log.summary || "—",
      "",
      ...(log.decisions ? [`> [!tip] ${t("关键决策")}`, `> ${log.decisions}`, ""] : []),
      ...(log.files.length ? [`> [!example] ${t("涉及文件")}`, ...log.files.map((item) => `> - \`${item}\``), ""] : []),
      ...(log.learnings ? [`> [!note] ${t("学到的东西")}`, `> ${log.learnings}`, ""] : []),
      ...(log.openQuestions ? [`> [!question] ${t("待确认")}`, `> ${log.openQuestions}`, ""] : []),
      log.tags.length ? tf("标签：{tags}", { tags: log.tags.map((tag) => `#${tag}`).join(" ") }) : "",
      "",
    ].join("\n");

    if (!bypassConfirm && this.isConfirmMode()) {
      const abstract = this.vault.getAbstractFileByPath(path);
      const exists = abstract instanceof TFile;
      const previous = exists ? await this.vault.read(abstract) : "";
      const preview = exists ? previous : `# ${t("工作日志")} ${log.date}\n\n`;
      return this.holdForConfirm("record_work_log", path, "worklog", { input }, previous, `${preview.trimEnd()}\n\n${block}`, meta);
    }

    await ensureFolder(this.vault, folder);
    const abstract = this.vault.getAbstractFileByPath(path);
    const file: TFile = abstract instanceof TFile ? abstract : await this.vault.create(path, `# ${t("工作日志")} ${log.date}\n\n`);
    const previous = await this.vault.read(file);
    this.plugin.tracker.markAgentWrite(path);
    await this.vault.modify(file, `${previous.trimEnd()}\n\n${block}`);
    this.plugin.store.updateDay(log.date, (day) => { day.aiWordsAdded += countWords(block); });
    this.plugin.store.addWorkLog(log);
    return log;
  },

  async addKnowledge(this: AgentApi, input: KnowledgeInput, bypassConfirm = false, meta?: WriteMeta) {
    const title = String(input.title || t("未命名笔记")).trim();
    const safeTitle = title.replace(/[\\/:*?"<>|#[\]]/g, "-").slice(0, 80) || t("未命名笔记");
    const base = normalizeFolder(this.plugin.store.settings.knowledgeFolder);
    const categories = this.categories();
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).replace(/^#/, "")) : [];
    const links = Array.isArray(input.links) ? input.links.map(String) : [];
    const agent = fmScalar(String(input.agent || "agent").replace(/[:#]/g, "-"));
    const requestedCategory = String(input.category ?? "").trim();
    const invalidCategory = requestedCategory.length > 0 && !isSafePathSegmentName(requestedCategory);
    if (invalidCategory) {
      this.plugin.store.logDiagnostic("security", tf("addKnowledge 拒绝了非法分类：{category}", { category: requestedCategory }));
    }
    const category =
      (invalidCategory ? "" : requestedCategory) ||
      (tags.length || String(input.content ?? "").length > 0
        ? this.inferCategory(title, String(input.content ?? ""), tags)
        : categories[0]) ||
      t("未分类");
    const sub = normalizeFolder(input.folder ?? "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
    const folder = [base, category, sub].filter(Boolean).join("/");
    this.assertPathAllowed(folder ? `${folder}/placeholder.md` : "placeholder.md", "create");

    const today = dateKey(new Date());
    let fileName = `${today}-${safeTitle}.md`;
    let path = folder ? `${folder}/${fileName}` : fileName;
    let counter = 2;
    while (this.vault.getAbstractFileByPath(path)) {
      fileName = `${today}-${safeTitle}-${counter}.md`;
      path = folder ? `${folder}/${fileName}` : fileName;
      counter += 1;
    }
    const safePath = safeAgentPath(path, this.vault.configDir ?? "");
    if (safePath !== path) throw new ApiError("FORBIDDEN", t("知识笔记目标路径不合法"), 403);
    this.assertPathAllowed(safePath, "create");
    path = safePath;

    const frontmatter = [
      "---", `date: ${today}`, "type: knowledge", "source: agent", "sediment_status: draft",
      `category: ${fmScalar(category)}`, `agent: ${fmScalar(agent)}`,
      ...(input.source ? [`origin: ${fmScalar(String(input.source).replace(/[:#]/g, "-"))}`] : []),
      tags.length ? "tags:" : "tags: []", ...tags.map((tag) => `  - ${fmScalar(tag)}`),
      links.length ? "links:" : "links: []", ...links.map((link) => `  - "${fmScalar(link).replace(/"/g, '\\"')}"`),
      "---",
    ].join("\n");

    const body = String(input.content || "").trim();
    const firstLine = body.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    const summary = firstLine.replace(/^[#>\-*0-9.\s]+/, "").slice(0, 120) || "—";
    const doc = [
      frontmatter, "", `# ${title}`, "", `> [!abstract] ${t("速览")}`, `> ${summary}`, "",
      `## ${t("正文")}`, "", body || "—", "",
      `## ${t("关联与来源")}`,
      ...(input.source ? [`- ${tf("来源：{value}", { value: `\`${String(input.source)}\`` })}`] : []),
      ...(links.length ? links.map((link) => `- ${tf("关联：{value}", { value: `[[${link}]]` })}`) : [`- ${tf("关联：{value}", { value: "—" })}`]),
      "", `## ${t("标签")}`, tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "—", "",
      "---", `> [!info]- ${t("沉淀信息")}`,
      `> ${tf("由 {agent} 于 {date} 写入 · Sediment", { agent: `**${agent}**`, date: today })}`, "",
    ].join("\n");

    this.assertPathAllowed(path, "create");
    if (!bypassConfirm && (meta?.hold || this.isConfirmMode())) {
      return { ...this.holdForConfirm("add_knowledge", path, "knowledge", { input }, "", doc, meta), path };
    }
    await ensureFolder(this.vault, folder);
    this.plugin.tracker.markAgentWrite(path);
    await this.vault.create(path, doc);
    this.plugin.store.updateDay(today, (day) => { day.aiWordsAdded += countWords(doc); });
    return {
      path,
      ...(invalidCategory ? { note: t("category 含路径分隔符，非法值已被忽略，笔记已回退到默认分类") } : {}),
    };
  },
};
