import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { t, tf } from "../i18n";

type DiffType = "same" | "add" | "remove";

interface DiffLine {
  type: DiffType;
  oldLine?: string;
  newLine?: string;
  oldIndex?: number;
  newIndex?: number;
}

/** 基于 LCS 的逐行差异，结果按旧/新两栏对齐。 */
export function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: "same", oldLine: oldLines[i], newLine: newLines[j], oldIndex: i + 1, newIndex: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "remove", oldLine: oldLines[i], oldIndex: i + 1 });
      i += 1;
    } else {
      lines.push({ type: "add", newLine: newLines[j], newIndex: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ type: "remove", oldLine: oldLines[i], oldIndex: i + 1 });
    i += 1;
  }
  while (j < m) {
    lines.push({ type: "add", newLine: newLines[j], newIndex: j + 1 });
    j += 1;
  }
  return lines;
}

/** 并排 Diff：差异行高亮、双栏滚动联动、可采纳任一侧。 */
export class DiffModal extends Modal {
  private left: HTMLElement | null = null;
  private right: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private mode: "diff" | "preview" = "diff";
  private component = new Component();
  private syncing = false;

  constructor(
    app: App,
    private titleText: string,
    private before: string,
    private after: string,
    private onRestore?: () => void,
    private onKeep?: () => void,
    /** 覆盖两个动作按钮的文案（如待审写入场景的「驳回丢弃 / 采纳写入」），不传保持原行为。 */
    private labels?: { restore?: string; keep?: string; leftTitle?: string; rightTitle?: string }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.component.load();
    contentEl.addClass("sd-diff-modal");
    contentEl.createEl("h2", { text: this.titleText });

    const meta = contentEl.createDiv({ cls: "sd-diff-meta" });
    const added = computeDiff(this.before, this.after).filter((line) => line.type === "add").length;
    const removed = computeDiff(this.before, this.after).filter((line) => line.type === "remove").length;
    meta.createSpan({ text: tf("+{n} 行", { n: added }) });
    meta.createSpan({ text: tf("-{n} 行", { n: removed }) });

    const modes = contentEl.createDiv({ cls: "sd-diff-modes" });
    for (const mode of ["diff", "preview"] as const) {
      const label = mode === "diff" ? t("差异") : t("渲染预览");
      const button = modes.createEl("button", { text: label });
      if (mode === this.mode) button.addClass("is-active");
      button.onclick = () => {
        if (this.mode === mode) return;
        this.mode = mode;
        modes.querySelectorAll("button").forEach((node) => node.toggleClass("is-active", node === button));
        this.renderMode();
      };
    }

    this.grid = contentEl.createDiv({ cls: "sd-diff-grid" });
    this.renderMode();

    const actions = contentEl.createDiv({ cls: "sd-diff-actions" });
    if (this.onRestore) {
      actions.createEl("button", { text: this.labels?.restore ?? t("采用备份（撤销本次修改）") }).onclick = () => {
        this.onRestore?.();
        this.close();
      };
    }
    actions.createEl("button", { cls: "mod-cta", text: this.labels?.keep ?? t("保留当前并关闭") }).onclick = () => {
      this.onKeep?.();
      this.close();
    };
  }

  /** 差异模式逐行高亮；预览模式把两侧 Markdown 渲染成最终排版，便于看效果而非源码。 */
  private renderMode(): void {
    if (!this.grid) return;
    this.grid.empty();
    this.left = null;
    this.right = null;
    if (this.mode === "diff") {
      this.left = this.column(this.grid, this.labels?.leftTitle ?? t("备份版本（修改前）"), "old");
      this.right = this.column(this.grid, this.labels?.rightTitle ?? t("当前版本（磁盘上）"), "new");
      this.renderLines(computeDiff(this.before, this.after));
      return;
    }
    const left = this.grid.createDiv({ cls: "sd-diff-column" });
    left.createDiv({ cls: "sd-diff-head", text: this.labels?.leftTitle ?? t("备份版本（修改前）") });
    const right = this.grid.createDiv({ cls: "sd-diff-column" });
    right.createDiv({ cls: "sd-diff-head", text: this.labels?.rightTitle ?? t("当前版本（磁盘上）") });
    for (const [source, target] of [[this.before, left], [this.after, right]] as const) {
      const body = target.createDiv({ cls: "sd-diff-preview" });
      if (source.trim()) {
        void MarkdownRenderer.render(this.app, source, body, "", this.component);
      } else {
        body.createDiv({ cls: "sd-diff-preview-empty", text: t("（空，新建文件）") });
      }
    }
  }

  private column(grid: HTMLElement, title: string, side: "old" | "new"): HTMLElement {
    const wrapper = grid.createDiv({ cls: "sd-diff-column" });
    wrapper.createDiv({ cls: "sd-diff-head", text: title });
    const body = wrapper.createDiv({ cls: "sd-diff-body" });
    body.addEventListener("scroll", () => {
      if (this.syncing) return;
      this.syncing = true;
      const other = side === "old" ? this.right : this.left;
      if (other) other.scrollTop = body.scrollTop;
      this.syncing = false;
    });
    return body;
  }

  private renderLines(lines: DiffLine[]): void {
    for (const line of lines) {
      const side: Array<"old" | "new"> = line.type === "same" ? ["old", "new"] : [line.type === "remove" ? "old" : "new"];
      for (const target of side) {
        const body = target === "old" ? this.left : this.right;
        if (!body) continue;
        const row = body.createDiv({ cls: `sd-diff-line is-${line.type}` });
        row.createSpan({ cls: "sd-diff-ln", text: String(target === "old" ? line.oldIndex ?? "" : line.newIndex ?? "") });
        row.createSpan({
          cls: "sd-diff-text",
          text: target === "old" ? line.oldLine ?? "" : line.newLine ?? "",
        });
      }
      if (line.type === "remove") {
        const row = this.right?.createDiv({ cls: "sd-diff-line is-placeholder" });
        row?.createSpan({ cls: "sd-diff-ln", text: "" });
        row?.createSpan({ cls: "sd-diff-text", text: "" });
      }
      if (line.type === "add") {
        const row = this.left?.createDiv({ cls: "sd-diff-line is-placeholder" });
        row?.createSpan({ cls: "sd-diff-ln", text: "" });
        row?.createSpan({ cls: "sd-diff-text", text: "" });
      }
    }
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}
