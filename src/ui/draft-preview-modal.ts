import { App, Component, MarkdownRenderer, Modal } from "obsidian";

/** 审核前只读预览 AI 草稿内容，不改变任何文件。 */
export class DraftPreviewModal extends Modal {
  private component = new Component();

  constructor(
    app: App,
    private titleText: string,
    private content: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.component.load();
    const { contentEl } = this;
    contentEl.addClass("sd-draft-preview");
    contentEl.createEl("h2", { text: this.titleText });
    const body = contentEl.createDiv({ cls: "sd-review-preview" });
    void MarkdownRenderer.render(this.app, this.content, body, "", this.component);
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}
