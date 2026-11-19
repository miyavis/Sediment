import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import type { MemoRecord } from "../types";
import { addDays, dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

export const MEMO_VIEW_TYPE = "sediment-memo";

type MemoTab = "all" | "review" | "walk" | "tags" | "knowledge";

/** 右侧栏速记面板：输入、图片附件、搜索、回顾、漫步与标签树。 */
export class MemoView extends ItemView {
  private tab: MemoTab = "all";
  private filter = "";
  private walkId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: SedimentPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return MEMO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "速记";
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("kp-memo-view");

    const tabs = root.createDiv({ cls: "sd-memo-tabs" });
    const options: Array<[MemoTab, string]> = [
      ["all", "全部"],
      ["review", "回顾"],
      ["walk", "漫步"],
      ["tags", "标签"],
      ["knowledge", "沉淀"],
    ];
    for (const [key, label] of options) {
      const button = tabs.createEl("button", {
        cls: `sd-memo-tab ${key === this.tab ? "is-active" : ""}`,
        text: label,
      });
      button.onclick = () => {
        this.tab = key;
        this.render();
      };
    }

    if (this.tab === "all") this.renderAll(root);
    else if (this.tab === "review") this.renderReview(root);
    else if (this.tab === "walk") this.renderWalk(root);
    else if (this.tab === "tags") this.renderTags(root);
    else this.renderKnowledge(root);
  }

  private renderAll(root: HTMLElement): void {
    const form = root.createDiv({ cls: "kp-memo-form" });
    const area = form.createEl("textarea", { cls: "kp-memo-input" });
    area.placeholder = "想到什么，随手记下…（可粘贴图片）";
    area.rows = 3;
    const row = form.createDiv({ cls: "kp-memo-row" });
    const tagInput = row.createEl("input", { type: "text", placeholder: "标签，空格分隔" });
    const submit = row.createEl("button", { cls: "mod-cta", text: "记一条" });

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

    const filterRow = root.createDiv({ cls: "kp-memo-filter" });
    const filterInput = filterRow.createEl("input", {
      type: "text",
      placeholder: "搜索速记 / 输入 #标签 筛选",
    });
    filterInput.value = this.filter;
    filterInput.addEventListener("input", () => {
      this.filter = filterInput.value.trim().toLowerCase();
      this.renderList(root);
    });

    this.renderList(root);
    this.renderKnowledge(root, 5, true);
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
    const area = this.contentEl.querySelector(".kp-memo-input") as HTMLTextAreaElement | null;
    if (area) {
      area.value += ` ![[${name}]]`;
      area.focus();
    }
    new Notice("图片已插入速记");
  }

  private renderList(root: HTMLElement): void {
    root.querySelector(".kp-memo-list")?.remove();
    const list = root.createDiv({ cls: "kp-memo-list" });
    let memos = this.plugin.store.data.memos.slice();
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
      list.createDiv({ cls: "kp-empty", text: "还没有速记，或没有匹配的速记。" });
      return;
    }
    let currentDate = "";
    for (const memo of memos) {
      if (memo.date !== currentDate) {
        currentDate = memo.date;
        list.createDiv({ cls: "kp-memo-date", text: currentDate });
      }
      list.appendChild(this.memoCard(memo));
    }
  }

  private memoCard(memo: MemoRecord): HTMLElement {
    const card = document.createElement("div");
    card.className = "kp-memo-card";
    card.createDiv({ cls: "kp-memo-time", text: memo.time });
    card.createDiv({ cls: "kp-memo-text", text: memo.text });
    if (memo.tags.length > 0) {
      const tags = card.createDiv({ cls: "kp-memo-tags" });
      for (const tag of memo.tags) {
        const button = tags.createEl("button", { cls: "kp-tag", text: `#${tag}` });
        button.onclick = () => {
          this.filter = `#${tag}`;
          this.tab = "all";
          this.render();
        };
      }
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
        card.createDiv({ cls: "kp-empty", text: "这天没有速记。" });
        return;
      }
      for (const memo of items.slice(0, 3)) card.appendChild(this.memoCard(memo));
    };
    section(`每日回顾 · ${todayKey}`, this.pick(todays, todayKey));
    section(`去年今日 · ${lastYearKey}`, memos.filter((memo) => memo.date === lastYearKey));
    section(`上月今日 · ${lastMonthKey}`, memos.filter((memo) => memo.date === lastMonthKey));
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
      root.createDiv({ cls: "kp-empty", text: "还没有速记可以漫步。" });
      return;
    }
    let current = memos.find((memo) => memo.id === this.walkId) ?? memos[0];
    const card = root.createDiv({ cls: "sd-card sd-walk" });
    card.createDiv({ cls: "sd-card-sub", text: `漫步 · ${current.date} ${current.time}` });
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
      card.createDiv({ cls: "sd-card-sub", text: `共同的词：${shared} 个` });
      const button = card.createEl("button", { text: "继续漫步 →" });
      button.onclick = () => {
        this.walkId = next.id;
        this.render();
      };
    }
    this.walkId = current.id;
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
          cls: "kp-empty",
          text: "还没有沉淀。让智能体调用 add_knowledge 或 record_work_log 后，笔记会出现在这里。",
        });
      }
      return;
    }

    const knowledgeFolder = normalizeFolder(settings.knowledgeFolder);
    const groups = new Map<string, typeof files>();
    for (const file of files) {
      let category = "工作日志";
      if (knowledgeFolder && file.path.startsWith(`${knowledgeFolder}/`)) {
        const parts = file.path.split("/");
        category = parts.length > 1 ? parts[1] : "未分类";
      }
      const group = groups.get(category) ?? [];
      group.push(file);
      groups.set(category, group);
    }

    const card = root.createDiv({ cls: "sd-card sd-knowledge" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({
      cls: "sd-card-title",
      text: compact ? `最近沉淀 · ${files.length}` : `知识沉淀 · ${files.length}`,
    });
    if (compact) {
      const more = head.createEl("button", { text: "全部" });
      more.onclick = () => {
        this.tab = "knowledge";
        this.render();
      };
    }
    for (const [category, items] of groups) {
      const section = card.createDiv({ cls: "sd-knowledge-group" });
      section.createDiv({ cls: "sd-knowledge-category", text: `${category} · ${items.length}` });
      const list = section.createDiv({ cls: "sd-knowledge-list" });
      for (const file of items) {
        const row = list.createDiv({ cls: "sd-knowledge-item" });
        const button = row.createEl("button", { cls: "sd-knowledge-open", text: file.basename });
        button.onclick = () => void this.plugin.app.workspace.openLinkText(file.path, "", false);
        row.createDiv({ cls: "sd-knowledge-path", text: file.path });
      }
    }
  }

  private renderTags(root: HTMLElement): void {
    const counts = new Map<string, number>();
    for (const memo of this.plugin.store.data.memos) {
      for (const tag of memo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const card = root.createDiv({ cls: "sd-card sd-tag-tree" });
    card.createDiv({ cls: "sd-card-title", text: `标签 · ${counts.size} 个` });
    if (counts.size === 0) {
      card.createDiv({ cls: "kp-empty", text: "还没有标签。" });
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
