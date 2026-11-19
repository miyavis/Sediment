import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { CHANGELOG } from "../changelog";

/** 展示由 CHANGELOG.md 同步进插件的增量更新记录。 */
export class ChangelogModal extends Modal {
  private component = new Component();

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.component.load();
    const { contentEl } = this;
    contentEl.addClass("sd-changelog-modal");
    contentEl.createEl("h2", { text: "Sediment 更新记录" });
    const body = contentEl.createDiv({ cls: "sd-changelog-body" });
    void MarkdownRenderer.render(this.app, CHANGELOG, body, "", this.component);
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}
