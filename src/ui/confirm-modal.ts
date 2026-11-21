import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/**
 * 用 Obsidian 原生弹窗替代 window.confirm：跟随主题、可键盘操作，
 * 也避免审核规则对浏览器同步确认框的告警。
 */
export function confirmAction(app: App, message: string, cta = t("继续")): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, message, cta, resolve).open());
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly cta: string,
    private readonly resolve: (value: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("请确认"));
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("取消")).onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText(this.cta).setCta().onClick(() => this.finish(true)));
  }

  onClose(): void {
    this.contentEl.empty();
    // 点击遮罩、按 Esc 关闭时同样视为取消，保证 Promise 一定落定。
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }

  private finish(result: boolean): void {
    this.settled = true;
    this.resolve(result);
    this.close();
  }
}
