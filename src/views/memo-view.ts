import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { exportMemoCard } from "../features/embed";
import type { MemoRecord } from "../types";
import { addDays, dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import { t, tf } from "../i18n";

export const MEMO_VIEW_TYPE = "sediment-memo";

type MemoTab = "all" | "review" | "walk" | "tags" | "knowledge";

/** 右侧栏速记面板：输入、图片附件、搜索、回顾、漫步与标签树。 */
export class MemoView extends ItemView {
  private tab: MemoTab = "all";
  private showMoreTabs = false;
  private filter = "";
  private walkId: string | null = null;
  private showArchived = false;

  constructor(leaf: WorkspaceLeaf, private plugin: SedimentPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return MEMO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("速记");
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    this.render();
    this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.refreshContent()));
  }

  /** 只刷新列表和沉淀区，不碰用户正在输入的速记框。 */
  refreshContent(): void {
    if (this.tab !== "all") {
      this.render();
      return;
    }
    const root = this.contentEl;
    root.querySelector(".sd-memo-list")?.remove();
    root.querySelector(".sd-knowledge-inline")?.remove();
    root.querySelector(".sd-context-card")?.remove();
    this.renderList(root);
    this.renderKnowledge(root, 30, true);
    this.renderContext(root);
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("sd-memo-view");
    root.setAttribute("data-density", this.plugin.store.settings.layoutDensity);
    root.toggleClass("is-reduced-motion", this.plugin.store.settings.reducedMotion);

    const tabs = root.createDiv({ cls: "sd-memo-tabs" });
    const primary = tabs.createEl("button", {
      cls: `sd-memo-tab ${this.tab === "all" ? "is-active" : ""}`,
      text: t("全部"),
      attr: { role: "tab", "aria-selected": this.tab === "all" ? "true" : "false" },
    });
    primary.onclick = () => {
      this.tab = "all";
      this.render();
    };
    const more = tabs.createEl("button", {
      cls: `sd-memo-tab sd-memo-more ${this.showMoreTabs || this.tab !== "all" ? "is-active" : ""}`,
      text: t("更多"),
      attr: { "aria-expanded": this.showMoreTabs ? "true" : "false" },
    });
    more.onclick = () => {
      this.showMoreTabs = !this.showMoreTabs;
      this.render();
    };
    if (this.showMoreTabs || this.tab !== "all") {
      const secondary = root.createDiv({ cls: "sd-memo-subtabs" });
      const options: Array<[MemoTab, string]> = [
        ["review", t("回顾")],
        ["walk", t("漫步")],
        ["tags", t("标签")],
        ["knowledge", t("沉淀")],
      ];
      for (const [key, label] of options) {
        const button = secondary.createEl("button", {
          cls: `sd-memo-tab ${key === this.tab ? "is-active" : ""}`,
          text: label,
          attr: { role: "tab", "aria-selected": key === this.tab ? "true" : "false" },
        });
        button.onclick = () => {
          this.tab = key;
          this.showMoreTabs = true;
          this.render();
        };
      }
    }

    if (this.tab === "all") this.renderAll(root);
    else if (this.tab === "review") this.renderReview(root);
    else if (this.tab === "walk") this.renderWalk(root);
    else if (this.tab === "tags") this.renderTags(root);
    else this.renderKnowledge(root);
  }

  private renderAll(root: HTMLElement): void {
    const form = root.createDiv({ cls: "sd-memo-form" });
    const area = form.createEl("textarea", { cls: "sd-memo-input" });
    area.placeholder = t("想到什么，随手记下…（可粘贴图片）");
    area.rows = 3;
    const row = form.createDiv({ cls: "sd-memo-row" });
    const tagInput = row.createEl("input", { type: "text", placeholder: t("标签，空格分隔") });
    const submit = row.createEl("button", { cls: "mod-cta", text: t("记一条") });

    area.addEventListener("paste", (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          event.preventDefault();
          void this.attachImage(item.getAsFile());
        }
      }
    });

    const doSubmit = (): void => {
      const text = area.value.trim();
      if (!text) return;
      const tags = tagInput.value
        .split(/\s+/)
        .map((tag) => tag.replace(/^#/, ""))
        .filter(Boolean);
      void this.plugin.memos.add(text, tags).then((memo) => {
        if (!memo) return;
        area.value = "";
        tagInput.value = "";
        this.walkId = memo.id;
        this.render();
      });
    };
    submit.onclick = doSubmit;
    area.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        doSubmit();
      }
    });

    const filterRow = root.createDiv({ cls: "sd-memo-filter" });
    const filterInput = filterRow.createEl("input", {
      type: "text",
      placeholder: t("搜索速记 / 输入 #标签 筛选"),
    });
    filterInput.value = this.filter;
    filterInput.addEventListener("input", () => {
      this.filter = filterInput.value.trim().toLowerCase();
      this.renderList(root);
    });
    const archiveLabel = filterRow.createEl("label", { cls: "sd-archive-toggle" });
    const archiveBox = archiveLabel.createEl("input", { type: "checkbox" });
    archiveBox.checked = this.showArchived;
    archiveLabel.createSpan({ text: t("含归档") });
    archiveBox.addEventListener("change", () => {
      this.showArchived = archiveBox.checked;
      this.renderList(root);
    });

    this.renderList(root);
    this.renderKnowledge(root, 30, true);
    this.renderContext(root);
  }

  /** 与当前打开的笔记相关的历史速记和工作日志。 */
  private renderContext(root: HTMLElement): void {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;
    const card = root.createDiv({ cls: "sd-card sd-context-card" });
    card.createDiv({ cls: "sd-card-title", text: tf("与《{name}》相关", { name: file.basename }) });
    const relatedMemos = this.plugin.store.data.memos
      .filter((memo) => memo.text.includes(file.basename) || memo.text.includes(file.path))
      .slice(0, 5);
    const relatedLogs = this.plugin.store.data.workLogs
      .filter((log) => log.files.some((item) => item === file.path || item.endsWith(`/${file.basename}`)))
      .slice(0, 5);
    if (relatedMemos.length === 0 && relatedLogs.length === 0) {
      card.createDiv({ cls: "sd-empty", text: t("这篇笔记还没有相关的速记或工作日志。") });
      return;
    }
    const list = card.createDiv({ cls: "sd-knowledge-list" });
    for (const memo of relatedMemos) {
      const row = list.createDiv({ cls: "sd-knowledge-item" });
      row.createEl("button", { cls: "sd-knowledge-open", text: `${memo.date} ${memo.time}` });
      row.createDiv({ cls: "sd-knowledge-path", text: memo.text });
    }
    for (const log of relatedLogs) {
      const row = list.createDiv({ cls: "sd-knowledge-item" });
      row.createEl("button", { cls: "sd-knowledge-open", text: `${log.date} ${log.time} · ${log.agent}` });
      row.createDiv({ cls: "sd-knowledge-path", text: log.task });
    }
  }

  private async attachImage(file: File | null): Promise<void> {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const extension = file.type.split("/")[1] || "png";
    const name = `${Date.now()}.${extension}`;
    const config = this.plugin.app.vault as unknown as {
      getConfig?: (key: string) => string;
    };
    const folder = normalizeFolder(config.getConfig?.("attachmentFolderPath") ?? "attachments");
    await ensureFolder(this.plugin.app.vault, folder);
    const path = folder ? `${folder}/${name}` : name;
    await this.plugin.app.vault.createBinary(path, buffer);
    const area = this.contentEl.querySelector(".sd-memo-input") as HTMLTextAreaElement | null;
    if (area) {
      area.value += ` ![[${name}]]`;
      area.focus();
    }
    new Notice(t("图片已插入速记"));
  }

  private renderList(root: HTMLElement): void {
    root.querySelector(".sd-memo-list")?.remove();
    const list = root.createDiv({ cls: "sd-memo-list" });
    let memos = this.plugin.store.data.memos.slice();
    if (!this.showArchived) memos = memos.filter((memo) => !memo.archived);
    if (this.filter) {
      const term = this.filter.replace(/^#/, "");
      memos = memos.filter(
        (memo) =>
          memo.text.toLowerCase().includes(term) ||
          memo.tags.some((tag) => tag.toLowerCase().includes(term)) ||
          memo.date.includes(term)
      );
    }
    if (memos.length === 0) {
      list.createDiv({ cls: "sd-empty", text: t("还没有速记，或没有匹配的速记。") });
      return;
    }
    let currentDate = "";
    for (const memo of memos) {
      if (memo.date !== currentDate) {
        currentDate = memo.date;
        list.createDiv({ cls: "sd-memo-date", text: currentDate });
      }
      list.appendChild(this.memoCard(memo));
    }
  }

  private memoCard(memo: MemoRecord): HTMLElement {
    const card = document.createElement("div");
    card.className = "sd-memo-card";
    if (memo.archived) card.addClass("is-archived");
    card.createDiv({ cls: "sd-memo-time", text: memo.archived ? `${memo.time} · ${t("已归档")}` : memo.time });
    card.createDiv({
      cls: "sd-memo-status",
      text: memo.archived
        ? t("已归档")
        : memo.converted
          ? t("已沉淀")
          : memo.tags.includes("to-agent")
            ? t("已委派 Agent")
            : t("未处理"),
    });
    const textEl = card.createDiv({ cls: "sd-memo-text", text: memo.text });
    if (memo.tags.length > 0) {
      const tags = card.createDiv({ cls: "sd-memo-tags" });
      for (const tag of memo.tags) {
        const button = tags.createEl("button", { cls: "sd-tag", text: `#${tag}` });
        button.onclick = () => {
          this.filter = `#${tag}`;
          this.tab = "all";
          this.render();
        };
      }
    }
    if (memo.sourcePath) {
      const source = card.createEl("button", {
        cls: "sd-memo-source",
        text: `${t("原待办")} · ${memo.sourcePath.split("/").pop()}:${memo.sourceLine ?? 1}`,
      });
      source.onclick = () => void this.openSource(memo.sourcePath, memo.sourceLine);
    }
    const actions = card.createDiv({ cls: "sd-memo-actions" });
    actions.createEl("button", { text: t("复制") }).onclick = () => {
      void navigator.clipboard.writeText(memo.text).then(() => new Notice(t("已复制")));
    };
    actions.createEl("button", { text: t("分享图") }).onclick = () => exportMemoCard(memo, "minimal");
    actions.createEl("button", { text: t("编辑") }).onclick = () => {
      const area = document.createElement("textarea");
      area.className = "sd-memo-edit";
      area.value = memo.text;
      area.rows = Math.min(8, Math.max(3, memo.text.split("\n").length + 1));
      textEl.replaceWith(area);
      area.focus();
      const bar = document.createElement("div");
      bar.className = "sd-memo-edit-bar";
      const save = bar.createEl("button", { cls: "mod-cta", text: t("保存") });
      const cancel = bar.createEl("button", { text: t("取消") });
      area.after(bar);
      save.onclick = () => {
        void this.plugin.memos.edit(memo.id, area.value).then((updated) => {
          if (updated) this.render();
          else new Notice(t("内容为空，未保存"));
        });
      };
      cancel.onclick = () => this.render();
      area.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          save.click();
        } else if (event.key === "Escape") {
          cancel.click();
        }
      });
    };
    actions.createEl("button", { text: memo.archived ? t("取消归档") : t("归档") }).onclick = () => {
      this.plugin.memos.setArchived(memo.id, !memo.archived);
      new Notice(memo.archived ? t("已归档，可在「含归档」中查看") : t("已取消归档"));
      this.render();
    };
    actions.createEl("button", { cls: "sd-memo-delete", text: t("删除") }).onclick = () => {
      if (!window.confirm(t("删除这条速记？日记中对应的速记记录也会一并移除。"))) return;
      void this.plugin.memos.remove(memo.id).then(() => this.render());
    };
    if (!memo.tags.includes("to-agent") && !memo.converted) {
      actions.createEl("button", { text: t("转 Agent") }).onclick = () => {
        memo.tags.push("to-agent");
        this.plugin.store.scheduleSave();
        void this.plugin.memos.syncTags(memo);
        new Notice(t("已加入 Agent 待办"));
        this.render();
      };
    }
    return card;
  }

  /** 同一天的回顾固定不变，可换一批；并显示去年今日和上月今日。 */
  private renderReview(root: HTMLElement): void {
    const today = new Date();
    const todayKey = dateKey(today);
    const memos = this.plugin.store.data.memos;

    const todays = memos.filter((memo) => memo.date === todayKey);
    const lastYearKey = `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const lastMonth = addDays(new Date(today.getFullYear(), today.getMonth() - 1, 1), Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth(), 0).getDate()) - 1);
    const lastMonthKey = dateKey(lastMonth);

    const section = (title: string, items: MemoRecord[]): void => {
      const card = root.createDiv({ cls: "sd-card sd-review-section" });
      card.createDiv({ cls: "sd-card-title", text: title });
      if (items.length === 0) {
        card.createDiv({ cls: "sd-empty", text: t("这天没有速记。") });
        return;
      }
      for (const memo of items.slice(0, 3)) card.appendChild(this.memoCard(memo));
    };
    section(`${t("每日回顾")} · ${todayKey}`, this.pick(todays, todayKey));
    section(`${t("去年今日")} · ${lastYearKey}`, memos.filter((memo) => memo.date === lastYearKey));
    section(`${t("上月今日")} · ${lastMonthKey}`, memos.filter((memo) => memo.date === lastMonthKey));
  }

  private pick(items: MemoRecord[], seed: string): MemoRecord[] {
    if (items.length <= 3) return items;
    let number = 0;
    for (const char of seed) number = (number * 31 + char.charCodeAt(0)) >>> 0;
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      number = (number * 1664525 + 1013904223) >>> 0;
      const target = number % (index + 1);
      [copy[index], copy[target]] = [copy[target], copy[index]];
    }
    return copy.slice(0, 3);
  }

  private tokens(text: string): string[] {
    const clean = text.toLowerCase().replace(/[#\[\]()]/g, " ");
    const chinese = clean.replace(/[^\u3400-\u9fff]/g, " ");
    const bigrams: string[] = [];
    for (let index = 0; index < chinese.length - 1; index += 1) {
      const pair = chinese.slice(index, index + 2).trim();
      if (pair.length === 2) bigrams.push(pair);
    }
    return [...bigrams, ...(clean.match(/[a-z0-9]+/g) ?? [])];
  }

  private renderWalk(root: HTMLElement): void {
    const memos = this.plugin.store.data.memos;
    if (memos.length === 0) {
      root.createDiv({ cls: "sd-empty", text: t("还没有速记可以漫步。") });
      return;
    }
    let current = memos.find((memo) => memo.id === this.walkId) ?? memos[0];
    const card = root.createDiv({ cls: "sd-card sd-walk" });
    card.createDiv({ cls: "sd-card-sub", text: `${t("漫步")} · ${current.date} ${current.time}` });
    card.appendChild(this.memoCard(current));

    const currentTokens = new Set(this.tokens(current.text));
    const ranked = memos
      .filter((memo) => memo.id !== current.id)
      .map((memo) => ({
        memo,
        score: this.tokens(memo.text).filter((token) => currentTokens.has(token)).length,
      }))
      .sort((a, b) => b.score - a.score);
    const next = ranked[0]?.memo;
    if (next) {
      const shared = ranked[0].score;
      card.createDiv({ cls: "sd-card-sub", text: tf("共同的词：{n} 个", { n: shared }) });
      const button = card.createEl("button", { text: t("继续漫步 →") });
      button.onclick = () => {
        this.walkId = next.id;
        this.render();
      };
    }
    this.walkId = current.id;
  }

  private async openSource(path?: string, line?: number): Promise<void> {
    if (!path) return;
    await this.plugin.app.workspace.openLinkText(path, "", false);
    if (line) {
      const editor = this.plugin.app.workspace.activeEditor?.editor;
      editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
    }
  }

  private renderKnowledge(root: HTMLElement, limit = 30, compact = false): void {
    const settings = this.plugin.store.settings;
    const folders = [normalizeFolder(settings.knowledgeFolder), normalizeFolder(settings.workLogFolder)]
      .filter((folder) => folder.length > 0);
    const files = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((file) => folders.some((folder) => file.path.startsWith(`${folder}/`)))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit);

    if (files.length === 0) {
      if (!compact) {
        root.createDiv({
          cls: "sd-empty",
          text: t("还没有沉淀。让智能体调用 add_knowledge 或 record_work_log 后，笔记会出现在这里。"),
        });
      }
      return;
    }

    const knowledgeFolder = normalizeFolder(settings.knowledgeFolder);
    const groups = new Map<string, typeof files>();
    for (const file of files) {
      let category = t("工作日志");
      if (knowledgeFolder && file.path.startsWith(`${knowledgeFolder}/`)) {
        const parts = file.path.split("/");
        category = parts.length > 1 ? parts[1] : t("未分类");
      }
      const group = groups.get(category) ?? [];
      group.push(file);
      groups.set(category, group);
    }

    const card = root.createDiv({ cls: "sd-card sd-knowledge" });
    if (compact) card.addClass("sd-knowledge-inline");
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({
      cls: "sd-card-title",
      text: `${t("知识沉淀")} · ${files.length}`,
    });
    if (compact) {
      const more = head.createEl("button", { text: t("全部") });
      more.onclick = () => {
        this.tab = "knowledge";
        this.render();
      };
    }
    for (const [category, items] of groups) {
      const section = card.createDiv({ cls: "sd-knowledge-group" });
      const head = section.createDiv({ cls: "sd-knowledge-group-head" });
      head.createSpan({ cls: "sd-category-badge", text: category });
      head.createSpan({ cls: "sd-category-count", text: String(items.length) });
      const list = section.createDiv({ cls: "sd-knowledge-list" });
      for (const file of items) {
        const date = (file.basename.match(/^(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? "";
        const display = file.basename.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/^\d+-/, "");
        const title = display.length > 26 ? `${display.slice(0, 26)}…` : display;
        const row = list.createDiv({ cls: "sd-knowledge-item" });
        const button = row.createEl("button", {
          cls: "sd-knowledge-open",
          text: title,
          attr: { title: file.basename },
        });
        button.onclick = () => void this.plugin.app.workspace.openLinkText(file.path, "", false);
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const rawTags = cache?.frontmatter?.tags;
        const tags = Array.isArray(rawTags)
          ? rawTags.slice(0, 3).map((tag) => `#${String(tag).replace(/^#/, "")}`)
          : [];
        row.createDiv({
          cls: "sd-knowledge-path",
          text: [date, file.parent?.path ?? "", ...tags].filter(Boolean).join(" · "),
        });
      }
    }
  }

  private renderTags(root: HTMLElement): void {
    const counts = new Map<string, number>();
    for (const memo of this.plugin.store.data.memos) {
      for (const tag of memo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const card = root.createDiv({ cls: "sd-card sd-tag-tree" });
    card.createDiv({ cls: "sd-card-title", text: `${t("标签")} · ${tf("{n} 个", { n: counts.size })}` });
    if (counts.size === 0) {
      card.createDiv({ cls: "sd-empty", text: t("还没有标签。") });
      return;
    }
    for (const [tag, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const button = card.createEl("button", { cls: "sd-tag-item", text: `#${tag} (${count})` });
      button.onclick = () => {
        this.filter = `#${tag}`;
        this.tab = "all";
        this.render();
      };
    }
  }
}
