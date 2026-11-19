import { App, Modal } from "obsidian";

/** 命令「记一条速记」弹出的轻量输入框。 */
export class QuickMemoModal extends Modal {
  private text = "";
  private tags = "";

  constructor(app: App, private onSubmit: (text: string, tags: string[]) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("kp-modal");
    contentEl.createEl("h2", { text: "记一条速记" });

    const area = contentEl.createEl("textarea", { cls: "kp-modal-input" });
    area.placeholder = "想到什么，随手记下…";
    area.rows = 6;
    area.addEventListener("input", () => {
      this.text = area.value;
    });

    const tagRow = contentEl.createDiv({ cls: "kp-modal-tags" });
    tagRow.createSpan({ text: "标签（空格分隔）" });
    const tagInput = tagRow.createEl("input", { type: "text", placeholder: "灵感 阅读" });
    tagInput.addEventListener("input", () => {
      this.tags = tagInput.value;
    });

    const actions = contentEl.createDiv({ cls: "kp-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    save.onclick = () => {
      if (!this.text.trim()) return;
      const tags = this.tags
        .split(/\s+/)
        .map((tag) => tag.replace(/^#/, ""))
        .filter(Boolean);
      this.onSubmit(this.text, tags);
      this.close();
    };

    area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
