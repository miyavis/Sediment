import { App, Modal } from "obsidian";

/** 用并排纯文本展示备份与当前内容，供人工核对。 */
export class DiffModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private before: string,
    private after: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("sd-diff-modal");
    contentEl.createEl("h2", { text: this.titleText });
    const grid = contentEl.createDiv({ cls: "sd-diff-grid" });
    const column = (title: string, content: string): void => {
      const box = grid.createDiv({ cls: "sd-diff-column" });
      box.createDiv({ cls: "sd-diff-head", text: title });
      box.createEl("pre", { cls: "sd-diff-body", text: content });
    };
    column("备份版本", this.before);
    column("当前版本", this.after);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
