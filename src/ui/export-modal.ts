import { App, Modal, Notice, Setting } from "obsidian";
import type { SedimentPlugin } from "../main";
import { DEFAULT_EXPORT_OPTIONS, exportData, type ExportOptions } from "../features/export";
import { t, tf } from "../i18n";

/** 数据导出：默认脱敏（不含令牌、速记正文与文件路径），写入库内 sediment-export/。 */
export class ExportModal extends Modal {
  private options: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS };

  constructor(app: App, private plugin: SedimentPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("导出数据") });
    contentEl.createDiv({
      cls: "sd-setup-hint",
      text: t("访问令牌等敏感设置永不导出。速记正文与文件路径默认剔除，勾选后才包含。文件写入库内 sediment-export/ 目录。"),
    });

    new Setting(contentEl)
      .setName(t("审计包（变更时间线）"))
      .setDesc(t("开启后导出谁/何时/改了什么/哈希/审批决定/快照，路径默认以短哈希代替。"))
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.options.audit)).onChange((value) => {
          this.options.audit = value;
        })
      );

    new Setting(contentEl)
      .setName(t("格式"))
      .setDesc(t("CSV 只含每日聚合指标；JSON 含天记录、速记元数据与工作日志。审计包下 CSV/JSON 均为事件流。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("json", t("JSON（完整结构）"))
          .addOption("csv", t("CSV（每日指标）"))
          .setValue(this.options.format)
          .onChange((value) => {
            this.options.format = value as "csv" | "json";
          })
      );

    new Setting(contentEl)
      .setName(t("包含速记正文"))
      .setDesc(t("关闭时只导出速记的时间、标签与状态。"))
      .addToggle((toggle) =>
        toggle.setValue(this.options.includeMemoText).onChange((value) => {
          this.options.includeMemoText = value;
        })
      );

    new Setting(contentEl)
      .setName(t("包含文件路径"))
      .setDesc(t("关闭时剔除来源待办路径、产出路径与工作日志涉及文件。"))
      .addToggle((toggle) =>
        toggle.setValue(this.options.includePaths).onChange((value) => {
          this.options.includePaths = value;
        })
      );

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(t("导出")).setCta().onClick(() => {
        button.setDisabled(true);
        void exportData(this.plugin.store, this.plugin.app.vault, this.options)
          .then((path) => {
            new Notice(tf("已导出：{path}", { path }));
            this.close();
            void this.plugin.app.workspace.openLinkText(path, "", false);
          })
          .catch((error) => {
            button.setDisabled(false);
            new Notice(`${t("导出失败")}: ${error instanceof Error ? error.message : String(error)}`);
          });
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}