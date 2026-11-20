import { App, Modal, Notice } from "obsidian";
import type { DiagnosticRecord } from "../types";
import { DIAGNOSTICS_CAP } from "../data/store";
import { localStamp } from "../utils/dates";
import { t, tf } from "../i18n";

/** 诊断弹窗一次最多渲染的行数；超出部分以「还有更多」提示，避免长列表卡顿。 */
const DISPLAY_LIMIT = 100;

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
    contentEl.createEl("h2", { text: t("诊断日志") });
    contentEl.createDiv({
      cls: "sd-card-sub",
      text: t("这里记录数据迁移、Agent 权限拒绝、慢查询与存储异常。不含令牌或笔记正文。"),
    });
    const list = contentEl.createDiv({ cls: "sd-diagnostic-list" });
    if (this.records.length === 0) {
      list.createDiv({ cls: "sd-empty", text: t("暂无诊断事件。") });
    }
    for (const record of this.records.slice(0, DISPLAY_LIMIT)) {
      const row = list.createDiv({ cls: `sd-diagnostic-row is-${record.category}` });
      row.createSpan({ cls: "sd-diagnostic-time", text: localStamp(record.time, true) });
      row.createSpan({ cls: "sd-diagnostic-tag", text: record.category });
      row.createSpan({ cls: "sd-diagnostic-msg", text: record.message });
      if (record.detail) row.createDiv({ cls: "sd-diagnostic-detail", text: record.detail });
    }
    // 存储上限 DIAGNOSTICS_CAP 条，弹窗只渲染前 DISPLAY_LIMIT 条：超出时明确告知还有更多。
    if (this.records.length > DISPLAY_LIMIT) {
      list.createDiv({
        cls: "sd-card-sub sd-diagnostic-more",
        text: tf("还有更多：共 {total} 条，仅显示前 {shown} 条（诊断日志最多保留 {cap} 条）。", {
          total: this.records.length,
          shown: DISPLAY_LIMIT,
          cap: DIAGNOSTICS_CAP,
        }),
      });
    }
    contentEl.createEl("button", { text: t("复制日志") }).onclick = () => {
      void navigator.clipboard.writeText(JSON.stringify(this.records, null, 2)).then(() => new Notice(t("日志已复制")));
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
