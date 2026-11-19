import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";

export const MEMO_VIEW_TYPE = "sediment-memo";

/** 右侧栏的速记面板：输入、标签筛选与按天分组浏览。 */
export class MemoView extends ItemView {
  private filter = "";

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

    const form = root.createDiv({ cls: "kp-memo-form" });
    const area = form.createEl("textarea", { cls: "kp-memo-input" });
    area.placeholder = "想到什么，随手记下…";
    area.rows = 3;

    const row = form.createDiv({ cls: "kp-memo-row" });
    const tagInput = row.createEl("input", { type: "text", placeholder: "标签，空格分隔" });
    const submit = row.createEl("button", { cls: "mod-cta", text: "记一条" });

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
      const card = list.createDiv({ cls: "kp-memo-card" });
      card.createDiv({ cls: "kp-memo-time", text: memo.time });
      card.createDiv({ cls: "kp-memo-text", text: memo.text });
      if (memo.tags.length > 0) {
        const tags = card.createDiv({ cls: "kp-memo-tags" });
        for (const tag of memo.tags) {
          const button = tags.createEl("button", { cls: "kp-tag", text: `#${tag}` });
          button.onclick = () => {
            this.filter = `#${tag}`;
            this.render();
          };
        }
      }
    }
  }
}
