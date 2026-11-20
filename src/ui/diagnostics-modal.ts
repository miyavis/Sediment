import { App, Modal, Notice } from "obsidian";
import type { DiagnosticRecord } from "../types";
import { localStamp } from "../utils/dates";

/** 真实环境诊断日志：迁移、安全拒绝、性能与存储事件。 */
export class DiagnosticsModal extends Modal {
  constructor(
    app: App,
    private records: DiagnosticRecord[]
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("sd-diagnostics-modal");
    contentEl.createEl("h2", { text: "诊断日志" });
    contentEl.createDiv({
      cls: "sd-card-sub",
      text: "这里记录数据迁移、Agent 权限拒绝、慢查询与存储异常。不含令牌或笔记正文。",
    });
    const list = contentEl.createDiv({ cls: "sd-diagnostic-list" });
    if (this.records.length === 0) {
      list.createDiv({ cls: "sd-empty", text: "暂无诊断事件。" });
    }
    for (const record of this.records.slice(0, 100)) {
      const row = list.createDiv({ cls: `sd-diagnostic-row is-${record.category}` });
      row.createSpan({ cls: "sd-diagnostic-time", text: localStamp(record.time, true) });
      row.createSpan({ cls: "sd-diagnostic-tag", text: record.category });
      row.createSpan({ cls: "sd-diagnostic-msg", text: record.message });
      if (record.detail) row.createDiv({ cls: "sd-diagnostic-detail", text: record.detail });
    }
    contentEl.createEl("button", { text: "复制日志" }).onclick = () => {
      void navigator.clipboard.writeText(JSON.stringify(this.records, null, 2)).then(() => new Notice("日志已复制"));
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
