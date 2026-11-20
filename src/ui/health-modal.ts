import { App, Modal, Notice } from "obsidian";
import type { SedimentPlugin } from "../main";
import {
  delegateHealthIssues,
  HEALTH_LABEL,
  scanNoteHealth,
  type HealthIssue,
} from "../features/health";
import { t, tf } from "../i18n";

/** 笔记健康度报告：勾选问题后一键转成 #to-agent 任务，交给智能体整理。 */
export class HealthModal extends Modal {
  private issues: HealthIssue[];
  private selected: Set<string>;

  constructor(app: App, private plugin: SedimentPlugin) {
    super(app);
    this.issues = scanNoteHealth(plugin);
    this.selected = new Set(this.issues.map((issue) => `${issue.kind}|${issue.path}`));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("笔记健康度") });
    contentEl.createDiv({
      cls: "sd-setup-hint",
      text: t("孤儿笔记＝无出链无反链；断链＝链接指向不存在的笔记；久未更新＝90 天以上。勾选后转为 Agent 任务，智能体整理完成会标记 #agent-done。"),
    });
    if (this.issues.length === 0) {
      contentEl.createDiv({ cls: "sd-empty", text: t("没有发现健康问题，库很整洁。") });
      return;
    }
    const counts = { orphan: 0, "broken-link": 0, stale: 0 } as Record<string, number>;
    for (const issue of this.issues) counts[issue.kind] += 1;
    contentEl.createDiv({
      cls: "sd-health-summary",
      text: tf("断链 {broken} · 孤儿 {orphan} · 久未更新 {stale}", {
        broken: counts["broken-link"],
        orphan: counts.orphan,
        stale: counts.stale,
      }),
    });

    const list = contentEl.createDiv({ cls: "sd-health-list" });
    for (const issue of this.issues) {
      const key = `${issue.kind}|${issue.path}`;
      const row = list.createDiv({ cls: "sd-health-item" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = this.selected.has(key);
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(key);
        else this.selected.delete(key);
        this.updateButton();
      });
      const body = row.createDiv({ cls: "sd-health-body" });
      const head = body.createDiv({ cls: "sd-health-head" });
      head.createSpan({ cls: `sd-health-badge is-${issue.kind}`, text: t(HEALTH_LABEL[issue.kind]) });
      const open = head.createEl("button", { cls: "sd-knowledge-open", text: issue.path });
      open.onclick = () => {
        void this.plugin.app.workspace.openLinkText(issue.path, "", false);
      };
      body.createDiv({ cls: "sd-health-detail", text: issue.detail });
    }

    const footer = contentEl.createDiv({ cls: "sd-health-footer" });
    this.button = footer.createEl("button", { cls: "mod-cta" });
    this.updateButton();
    this.button.onclick = () => {
      const chosen = this.issues.filter((issue) =>
        this.selected.has(`${issue.kind}|${issue.path}`)
      );
      if (chosen.length === 0) return;
      this.button.disabled = true;
      void delegateHealthIssues(this.plugin, chosen).then((count) => {
        new Notice(
          count > 0
            ? tf("已创建 {n} 条 Agent 整理任务（#to-agent #note-health）", { n: count })
            : t("所选问题都已有对应的未完成任务")
        );
        this.close();
        this.plugin.refreshViews(true);
      });
    };
  }

  private button!: HTMLButtonElement;

  private updateButton(): void {
    this.button.setText(tf("转为 Agent 任务（{n}）", { n: this.selected.size }));
    this.button.disabled = this.selected.size === 0;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}