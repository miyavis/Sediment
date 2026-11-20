import { Modal, type App } from "obsidian";
import type { Store } from "../data/store";
import { t, tf } from "../i18n";

/** 月报海报：从看板常驻卡片改为按需弹窗，左右切换月份，可导出 PNG。 */
export class PosterModal extends Modal {
  private month: number;
  private readonly year = new Date().getFullYear();

  constructor(app: App, private store: Store, month: number) {
    super(app);
    this.month = month;
  }

  onOpen(): void {
    this.contentEl.addClass("sd-poster-modal");
    this.renderPoster();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderPoster(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("月报海报") });
    const head = contentEl.createDiv({ cls: "sd-poster-head" });
    const prev = head.createEl("button", { text: "‹" });
    const title = head.createDiv({
      cls: "sd-poster-title",
      text: tf("{year} 年 {month} 月", { year: this.year, month: this.month + 1 }),
    });
    const next = head.createEl("button", { text: "›" });
    prev.onclick = () => {
      this.month = (this.month + 11) % 12;
      this.renderPoster();
    };
    next.onclick = () => {
      this.month = (this.month + 1) % 12;
      this.renderPoster();
    };

    const prefix = `${this.year}-${String(this.month + 1).padStart(2, "0")}`;
    const monthDays = Object.entries(this.store.data.days).filter(([key]) => key.startsWith(prefix));
    const monthTotal = monthDays.reduce((sum, [, day]) => sum + day.contribution, 0);
    const monthWords = monthDays.reduce((sum, [, day]) => sum + day.wordsAdded, 0);
    const monthActive = monthDays.filter(([, day]) => day.contribution > 0).length;

    const post = contentEl.createDiv({ cls: "sd-poster" });
    post.createDiv({ cls: "sd-poster-big", text: String(monthTotal) });
    post.createDiv({ cls: "sd-poster-sub", text: t("本月贡献分") });
    const stats = post.createDiv({ cls: "sd-poster-stats" });
    stats.createSpan({ text: tf("活跃 {n} 天", { n: monthActive }) });
    stats.createSpan({ text: tf("新增 {n} 字", { n: monthWords }) });
    const grid = post.createDiv({ cls: "sd-poster-grid" });
    for (let day = 1; day <= new Date(this.year, this.month + 1, 0).getDate(); day += 1) {
      const key = `${prefix}-${String(day).padStart(2, "0")}`;
      const value = this.store.getDay(key).contribution;
      grid.createDiv({ cls: "sd-poster-cell", attr: { title: `${key} · ${tf("{n} 分", { n: value })}` } }).setAttribute(
        "style",
        `background:var(--interactive-accent);opacity:${value > 0 ? 0.2 + Math.min(0.8, value / 12) : 0.06}`
      );
    }
    contentEl.createEl("button", { cls: "sd-poster-export", text: t("导出 PNG") }).onclick = () =>
      void this.exportPoster(title.textContent ?? "", monthTotal, monthWords, monthActive);
  }

  private async exportPoster(title: string, total: number, words: number, active: number): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 画布色跟随主题 CSS 变量；取不到时保留原浅色兜底，导出不再无视深色主题。
    const css = getComputedStyle(document.body);
    const themeColor = (name: string, fallback: string): string =>
      css.getPropertyValue(name).trim() || fallback;
    ctx.fillStyle = themeColor("--background-primary", "#f4f7fb");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = themeColor("--interactive-accent", "#2f6fb2");
    ctx.fillRect(0, 0, canvas.width, 260);
    ctx.fillStyle = themeColor("--text-on-accent", "#ffffff");
    ctx.font = "bold 64px sans-serif";
    ctx.fillText(title, 60, 130);
    ctx.fillStyle = themeColor("--text-normal", "#20344d");
    ctx.font = "bold 120px sans-serif";
    ctx.fillText(String(total), 60, 470);
    ctx.font = "32px sans-serif";
    ctx.fillText(tf("活跃 {n} 天", { n: active }) + " · " + tf("新增 {n} 字", { n: words }), 60, 610);
    const link = document.createElement("a");
    link.download = `sediment-${title.replace(/\s/g, "")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }
}