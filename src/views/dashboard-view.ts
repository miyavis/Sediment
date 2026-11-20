import { ItemView, Menu, Notice, Platform, type WorkspaceLeaf } from "obsidian";
import type { SedimentPlugin } from "../main";
import { ChangelogModal } from "../ui/changelog-modal";
import { PosterModal } from "../ui/poster-modal";
import { addDays, dateKey, lastNDays, parseKey } from "../utils/dates";
import { METRICS, type MetricKey } from "../types";
import { SEDIMENT_ICON_ID, SEDIMENT_LOGO_SVG } from "../ui/logo";
import { t, tf } from "../i18n";
import { TABS, type RangeKey, type TabKey } from "./dashboard/constants";
import { filterAgentTasks, pendingReviewChanges, reviewBadgeCount } from "./dashboard/review-queue";
import { listDraftFiles, renderAgentHub } from "./dashboard/sections/agent";
import { renderInsights } from "./dashboard/sections/insights";
import { renderToday } from "./dashboard/sections/today";

export const DASHBOARD_VIEW_TYPE = "sediment-dashboard";

/** 三段式主看板：今日脉冲 / 知识地层 / 智能体工坊。
 *  页签渲染逻辑位于 dashboard/sections/，本类保留生命周期与跨页签共享的辅助方法。 */
export class DashboardView extends ItemView {
  tab: TabKey = "today";
  metric: MetricKey = "contribution";
  range: RangeKey = "1y";
  trendTab: "writing" | "changes" | "time" | "source" = "writing";
  rhythmTab: "matrix" | "hours" = "matrix";
  yearlyTab: "wheel" | "fingerprint" | "moon" = "wheel";
  rhythmActiveOnly = true;
  foldersExpanded = false;
  insightsExpanded = false;
  /** 附属热力图折叠状态：重渲染（切指标/选日期）后保持展开。 */
  strataHeatmapOpen = false;
  insightsSection: "strata" | "overview" | "trend" | "folders" | "yearly" | "review" = "strata";
  selected: string | null = null;
  posterMonth = new Date().getMonth();
  bannerEl: HTMLElement | null = null;
  heatTooltip: HTMLElement | null = null;
  unsubscribePomodoro: (() => void) | null = null;
  lastRenderedTab: TabKey | null = null;
  hasRendered = false;
  scrollRestoreToken = 0;
  pendingFocusDate: string | null = null;

  constructor(leaf: WorkspaceLeaf, public plugin: SedimentPlugin) {
    super(leaf);
    this.metric = plugin.store.settings.heatmapMetric;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("Sediment 知识脉冲");
  }

  getIcon(): string {
    return SEDIMENT_ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.render();
    this.registerInterval(window.setInterval(() => this.updateBanner(), 60_000));
    this.unsubscribePomodoro = this.plugin.pomodoro.subscribe(() => this.updatePomodoroButton());
  }

  async onClose(): Promise<void> {
    this.unsubscribePomodoro?.();
    this.hideHeatTooltip();
  }

  render(): void {
    const root = this.contentEl;
    const rerender = this.hasRendered;
    const scroller = this.scrollParent(root) ?? this.fallbackScroller();
    const sameTab = this.lastRenderedTab === this.tab;
    const scrollTop = sameTab && scroller ? scroller.scrollTop : 0;
    root.empty();
    root.addClass("sd-dashboard");
    root.toggleClass("is-rerender", rerender);
    root.setAttribute("data-density", this.plugin.store.settings.layoutDensity);
    root.toggleClass("is-reduced-motion", this.plugin.store.settings.reducedMotion);
    root.setAttribute("data-tab", this.tab);
    this.renderHeader(root);

    if (this.tab === "today") renderToday(this, root);
    else if (this.tab === "insights") renderInsights(this, root);
    else renderAgentHub(this, root);
    // 页脚统一在 render() 末尾渲染，三个页签（含今日页）都有；section 内不再各自调用。
    this.renderFooter(root);
    this.lastRenderedTab = this.tab;

    // 同页签刷新保留滚动位置；切换页签则回到顶部。用户若主动滚动，取消这次恢复。
    this.hasRendered = true;
    if (scroller) {
      const token = ++this.scrollRestoreToken;
      window.requestAnimationFrame(() => {
        if (token !== this.scrollRestoreToken) return;
        scroller.scrollTop = scrollTop;
        window.requestAnimationFrame(() => {
          if (token === this.scrollRestoreToken) scroller.scrollTop = scrollTop;
        });
      });
    }
    if (this.pendingFocusDate) {
      const target = root.querySelector(
        `.sd-cell[data-date="${this.pendingFocusDate}"]`
      ) as HTMLElement | null;
      this.pendingFocusDate = null;
      target?.focus();
    }
  }

  /** 找到看板真正滚动的祖先容器（Obsidian 的 .view-content）。 */
  scrollParent(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return null;
  }

  fallbackScroller(): HTMLElement | null {
    return (this.containerEl.closest(".view-content") as HTMLElement | null) ??
      (this.containerEl.parentElement as HTMLElement | null);
  }

  /** 平滑滚动到目标，并为吸顶导航预留偏移。 */
  scrollToElement(target: HTMLElement, align: ScrollLogicalPosition = "start"): void {
    this.scrollRestoreToken += 1;
    target.scrollIntoView({ behavior: "smooth", block: align });
  }

  value(key: string): number {
    return Number(this.plugin.store.getDay(key)[this.metric]) || 0;
  }

  activeDaysCount(): number {
    return Object.values(this.plugin.store.data.days).filter((day) => day.contribution > 0).length;
  }

  /** 数据不足 14 天时，折线/柱状图默认聚焦最近 14 天，避免最右侧一根细线。 */
  chartKeys(): string[] {
    const keys = this.rangeKeys();
    return this.activeDaysCount() < 14 ? keys.slice(-14) : keys;
  }

  rangeKeys(): string[] {
    const today = new Date();
    if (this.range === "7d") return lastNDays(7, today);
    if (this.range === "30d") return lastNDays(30, today);
    if (this.range === "90d") return lastNDays(90, today);
    if (this.range === "ytd") {
      const keys: string[] = [];
      for (let day = new Date(today.getFullYear(), 0, 1); day <= today; day = addDays(day, 1)) {
        keys.push(dateKey(day));
      }
      return keys;
    }
    return lastNDays(365, today);
  }

  currentStreak(): number {
    let streak = 0;
    let cursor = new Date();
    if (this.plugin.store.getDay(dateKey(cursor)).contribution === 0) cursor = addDays(cursor, -1);
    while (this.plugin.store.getDay(dateKey(cursor)).contribution > 0 && streak < 400) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  longestStreak(): number {
    const keys = Object.keys(this.plugin.store.data.days)
      .filter((key) => this.plugin.store.getDay(key).contribution > 0)
      .sort();
    let longest = 0;
    let run = 0;
    let previous = "";
    for (const key of keys) {
      run = previous && dateKey(addDays(parseKey(previous), 1)) === key ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = key;
    }
    return longest;
  }

  metricLabel(): string {
    const label = METRICS.find((metric) => metric.key === this.metric)?.label;
    return label ? t(label) : this.metric;
  }

  shortMetric(key: string): string {
    const names: Record<string, string> = {
      contribution: "贡献",
      wordsAdded: "新增词",
      activeMinutes: "活跃",
      focusMinutes: "专注",
      notesCreated: "新笔记",
      tasksCompleted: "任务",
    };
    return names[key] ? t(names[key]) : key;
  }

  moonGlyph(date: Date): string {
    const synodic = 29.530588853 * 86400000;
    const known = new Date(2000, 0, 6, 18, 14).getTime();
    const phase = ((((date.getTime() - known) / synodic) % 1) + 1) % 1;
    if (phase < 0.03 || phase > 0.97) return "🌑";
    if (phase < 0.22) return "🌒";
    if (phase < 0.28) return "🌓";
    if (phase < 0.47) return "🌔";
    if (phase < 0.53) return "🌕";
    if (phase < 0.72) return "🌖";
    if (phase < 0.78) return "🌗";
    return "🌘";
  }

  showHeatTooltip(event: MouseEvent, key: string): void {
    this.hideHeatTooltip();
    const day = this.plugin.store.getDay(key);
    const tip = document.createElement("div");
    tip.className = "sd-heat-tooltip";
    tip.createDiv({ cls: "sd-tip-date", text: key });
    tip.createDiv({
      cls: "sd-tip-metric",
      text:
        tf("贡献 {c} 分 · 新增 {w} 字", { c: day.contribution, w: day.wordsAdded }) +
        (day.aiWordsAdded > 0 ? tf("（AI {n}）", { n: day.aiWordsAdded }) : ""),
    });
    const notes = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.includes(key))
      .map((file) => file.basename)
      .slice(0, 4);
    if (notes.length > 0) tip.createDiv({ cls: "sd-tip-notes", text: tf("笔记：{list}", { list: notes.join(t("、")) }) });
    const memos = this.plugin.store.data.memos.filter((memo) => memo.date === key).slice(0, 2);
    if (memos.length > 0) tip.createDiv({ cls: "sd-tip-notes", text: tf("速记：{list}", { list: memos.map((memo) => memo.text).join(" / ") }) });
    document.body.appendChild(tip);
    this.heatTooltip = tip;
    this.moveHeatTooltip(event);
  }

  moveHeatTooltip(event: MouseEvent): void {
    if (!this.heatTooltip) return;
    this.heatTooltip.style.left = `${event.clientX + 14}px`;
    this.heatTooltip.style.top = `${event.clientY + 14}px`;
  }

  hideHeatTooltip(): void {
    this.heatTooltip?.remove();
    this.heatTooltip = null;
  }

  renderHeader(root: HTMLElement): void {
    const banner = root.createDiv({ cls: "sd-banner" });
    banner.innerHTML = this.bannerSvg();
    this.bannerEl = banner;

    const bar = root.createDiv({ cls: "sd-navbar" });
    const brand = bar.createDiv({ cls: "sd-brand" });
    brand.insertAdjacentHTML("afterbegin", SEDIMENT_LOGO_SVG);
    brand.createSpan({ text: "SEDIMENT" });
    const tabs = bar.createDiv({ cls: "sd-tabs" });
    for (const [key, label] of TABS) {
      // 移动端隐藏智能体工坊入口（README 移动端承诺：Agent 管理留在桌面端）。
      if (Platform.isMobile && key === "agent") continue;
      const button = tabs.createEl("button", {
        cls: `sd-tab ${key === this.tab ? "is-active" : ""}`,
        text: t(label),
        attr: { role: "tab", "aria-selected": key === this.tab ? "true" : "false" },
      });
      if (key === "agent") {
        const badge = reviewBadgeCount({
          drafts: listDraftFiles(this).length,
          changes: pendingReviewChanges(
            this.plugin.store.data.toolCalls,
            this.plugin.store.data.reviewedChanges
          ).length,
          pendingWrites: (this.plugin.store.data.pendingWrites ?? []).length,
        });
        if (badge > 0) {
          button.createSpan({ cls: "sd-tab-badge", text: String(badge) });
          button.setAttribute("aria-label", `${t(label)} · ${tf("待审 {n} 项", { n: badge })}`);
        }
      }
      button.onclick = () => {
        this.tab = key;
        this.render();
      };
    }
    const spacer = bar.createDiv({ cls: "sd-spacer" });
    spacer.setAttribute("style", "flex:1");
    const refresh = bar.createEl("button", { cls: "sd-refresh", text: t("刷新") });
    refresh.onclick = () => this.render();
  }

  /** 待办卡。agentOnly=true 时只渲染 Agent 委派子集（审核队列契约），今日页仍合并今日/遗留/Agent。 */
  renderTasksCard(root: HTMLElement, agentOnly = false): void {
    const card = root.createDiv({ cls: "sd-card sd-tasks" });
    card.createDiv({
      cls: "sd-card-title",
      text: agentOnly ? t("Agent 待办") : t("待办 · 今日 / 遗留 / Agent"),
    });
    const list = card.createDiv({ cls: "sd-task-list" });
    list.createDiv({ cls: "sd-empty", text: t("加载中…") });
    const load = agentOnly
      ? this.plugin.tasks.list("agent").then((agent) => filterAgentTasks(agent))
      : Promise.all([
          this.plugin.tasks.list("today"),
          this.plugin.tasks.list("overdue"),
          this.plugin.tasks.list("agent"),
        ]).then(([today, overdue, agent]) => [
          ...today.filter((task) => !task.checked),
          ...overdue,
          ...agent,
        ]);
    void load.then((items) => {
      list.empty();
      if (items.length === 0) {
        list.createDiv({
          cls: "sd-empty",
          text: agentOnly ? t("没有委派的 Agent 待办。") : t("没有未完成待办。"),
        });
        return;
      }
      for (const task of items.slice(0, 12)) {
        const row = list.createDiv({ cls: "sd-task-item" });
        const button = row.createEl("button", {
          cls: "sd-task-open",
          text: task.text,
          attr: { title: task.path || t("Agent 任务") },
        });
        if (task.path) button.onclick = () => void this.plugin.app.workspace.openLinkText(task.path, "", false);
        else if (task.sourcePath)
          button.onclick = () => void this.openTaskSource(task.sourcePath, task.sourceLine);
        row.createDiv({
          cls: "sd-task-meta",
          text: task.path
            ? `${task.date} · ${task.path.split("/").pop()}:${task.line}`
            : task.sourcePath
              ? `Agent · ${t("原待办")} ${task.sourcePath.split("/").pop()}:${task.sourceLine ?? 1}`
              : `Agent · ${task.date}`,
        });
        const actions = row.createDiv({ cls: "sd-task-actions" });
        if (task.path) {
          const complete = actions.createEl("button", { text: t("完成") });
          complete.onclick = () => {
            // confirm 弹窗与落盘期间禁用按钮，防双击重复完成。
            complete.disabled = true;
            if (!window.confirm(t("确认将此待办标记为完成？"))) {
              complete.disabled = false;
              return;
            }
            void this.plugin.tasks.complete(task.path, task.line).then(() => {
              new Notice(t("待办已完成"));
              this.render();
            }).catch((error) => {
              complete.disabled = false;
              new Notice(error instanceof Error ? error.message : t("操作失败"));
            });
          };
        } else if (task.memoId) {
          actions.createEl("button", { text: t("认领") }).onclick = () => {
            void this.plugin.agentApi.claimAgentTask(task.memoId!, true).then(() => {
              new Notice(t("任务已认领"));
              this.render();
            }).catch((error) => new Notice(error instanceof Error ? error.message : t("操作失败")));
          };
          const complete = actions.createEl("button", { text: t("完成") });
          complete.onclick = () => {
            complete.disabled = true;
            if (!window.confirm(t("确认完成此 Agent 待办？"))) {
              complete.disabled = false;
              return;
            }
            void this.plugin.agentApi.completeAgentTask(task.memoId!, undefined, true).then(() => {
              new Notice(t("Agent 待办已完成"));
              this.render();
            }).catch((error) => {
              complete.disabled = false;
              new Notice(error instanceof Error ? error.message : t("操作失败"));
            });
          };
        }
      }
    });
  }

  async openTaskSource(path?: string, line?: number): Promise<void> {
    if (!path) return;
    await this.plugin.app.workspace.openLinkText(path, "", false);
    if (line) {
      const editor = this.plugin.app.workspace.activeEditor?.editor;
      editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
    }
  }

  renderFooter(root: HTMLElement): HTMLElement {
    const footer = root.createDiv({ cls: "sd-footer" });
    footer.createSpan({ text: `Sediment ${this.plugin.manifest.version} · ${t("数据只留在本地")}` });
    const changelog = footer.createEl("button", { text: t("更新记录") });
    changelog.onclick = () => new ChangelogModal(this.plugin.app).open();
    const styleButton = footer.createEl("button", { text: t("换画风") });
    styleButton.onclick = (event) => this.showArtStyleMenu(event);
    // 月报入口原在 insights section 内追加到页脚；页脚上移后按页签在此统一挂载。
    if (this.tab === "insights") {
      footer.createEl("button", { text: t("月报") }).onclick = () => {
        new PosterModal(this.plugin.app, this.plugin.store, this.posterMonth).open();
      };
    }
    return footer;
  }

  analyticsCard(root: HTMLElement, title: string, subtitle = ""): HTMLElement {
    const card = root.createDiv({ cls: "sd-card" });
    const head = card.createDiv({ cls: "sd-card-head" });
    head.createDiv({ cls: "sd-card-title", text: title });
    if (subtitle) head.createDiv({ cls: "sd-card-sub", text: subtitle });
    return card;
  }

  bannerSvg(): string {
    const style = this.plugin.store.settings.artStyle;
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const daylight = hour >= 6 && hour < 18;
    const x = 180 + (hour / 24) * 1240;
    const y = Math.max(34, 60 - Math.sin(((hour - 6) / 12) * Math.PI) * 34);
    const celestial = daylight
      ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="34" fill="#ffe08a"/>`
      : `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="30" fill="#f2f0dc"/><text x="${x.toFixed(0)}" y="${(y + 10).toFixed(0)}" font-size="30" text-anchor="middle">${this.moonGlyph(now)}</text>`;
    if (style === "ink") {
      return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="#e9e7e1"/>
<path d="M0 150 q300 -90 560 10 q260 -120 520 -20 q260 -70 520 30 L1600 300 L0 300 Z" fill="#9aa0a3" opacity="0.5"/>
<path d="M0 210 q240 -70 480 10 q300 -90 560 -10 q260 -50 560 20 L1600 300 L0 300 Z" fill="#5f676c" opacity="0.6"/>
${celestial}
<rect x="1460" y="40" width="62" height="62" fill="#b6473f" opacity="0.85"/>
<text x="1491" y="82" font-size="30" text-anchor="middle" fill="#fff">沉</text></svg>`;
    }
    if (style === "city") {
      const buildings = Array.from({ length: 34 }, (_, index) => {
        const width = 28 + (index % 4) * 6;
        const height = 70 + ((index * 37) % 110);
        const bx = index * 48;
        const windows = Array.from({ length: 4 }, (_, row) =>
          Array.from({ length: 3 }, (_, col) =>
            `<rect x="${bx + 7 + col * 8}" y="${300 - height + 12 + row * 16}" width="4" height="6" fill="${(index + row + col) % 3 === 0 ? "#ffd987" : "#dbe6f0"}" opacity="0.7"/>`
          ).join("")
        ).join("");
        return `<rect x="${bx}" y="${300 - height}" width="${width}" height="${height}" fill="${daylight ? "#6d87a7" : "#2a3b57"}"/>${windows}`;
      }).join("");
      return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<rect width="1600" height="300" fill="${daylight ? "#d8b79b" : "#1b2740"}"/>${celestial}${buildings}</svg>`;
    }
    return `<svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice" class="sd-banner-svg">
<defs>
  <linearGradient id="sd-lake-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#7fb0dc" : "#1c2b47"}"/>
    <stop offset="65%" stop-color="${daylight ? "#b4d6ee" : "#365078"}"/>
    <stop offset="100%" stop-color="${daylight ? "#e2f0f9" : "#6f8aa9"}"/>
  </linearGradient>
  <radialGradient id="sd-lake-glow"><stop offset="0%" stop-color="${daylight ? "#fff3c4" : "#eef2ff"}" stop-opacity="0.55"/><stop offset="100%" stop-color="${daylight ? "#fff3c4" : "#eef2ff"}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sd-lake-water" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${daylight ? "#8dbadd" : "#2d4163"}"/>
    <stop offset="100%" stop-color="${daylight ? "#cfe4f2" : "#4a6384"}"/>
  </linearGradient>
</defs>
<rect width="1600" height="300" fill="url(#sd-lake-sky)"/>
<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="150" fill="url(#sd-lake-glow)"/>
${celestial}
<path d="M120 76 q70 -30 140 -2 q45 -20 96 4" stroke="#ffffff" stroke-width="14" fill="none" opacity="0.16" stroke-linecap="round"/>
<path d="M720 120 q80 -26 160 0 q50 -18 100 4" stroke="#ffffff" stroke-width="10" fill="none" opacity="0.12" stroke-linecap="round"/>
<path d="M0 218 L120 168 L210 200 L330 132 L450 200 L560 158 L690 214 L820 170 L960 218 L1090 166 L1220 210 L1360 158 L1500 204 L1600 176 L1600 250 L0 250 Z" fill="#6f9dc6" opacity="0.28"/>
<path d="M0 238 L120 184 L210 214 L330 146 L450 214 L560 172 L690 228 L820 184 L960 232 L1090 180 L1220 224 L1360 172 L1500 218 L1600 190 L1600 264 L0 264 Z" fill="#3f6f9f" opacity="0.5"/>
<rect y="244" width="1600" height="16" fill="${daylight ? "#e2f0f9" : "#8ba4bf"}" opacity="0.18"/>
<rect x="138" y="152" width="20" height="86" fill="#f5f5f2"/>
<path d="M138 168 h20 M138 198 h20" stroke="#d9544d" stroke-width="8"/>
<path d="M136 152 h24 l-6 -14 h-12 Z" fill="#d9544d"/>
<rect x="143" y="134" width="10" height="8" fill="#ffe9a8"/>
<rect y="258" width="1600" height="42" fill="url(#sd-lake-water)" opacity="0.85"/>
<ellipse cx="${x.toFixed(0)}" cy="276" rx="46" ry="8" fill="${daylight ? "#fff3c4" : "#eef2ff"}" opacity="0.2"/></svg>`;
  }

  updateBanner(): void {
    if (this.bannerEl) this.bannerEl.innerHTML = this.bannerSvg();
  }

  updatePomodoroButton(): void {
    const button = this.contentEl.querySelector(".sd-pomodoro-button") as HTMLButtonElement | null;
    if (!button) return;
    const state = this.plugin.pomodoro.state();
    const minutes = String(Math.floor(state.remaining / 60)).padStart(2, "0");
    const seconds = String(state.remaining % 60).padStart(2, "0");
    const mode = state.mode === "focus" ? t("番茄") : state.mode === "short" ? t("短休") : t("长休");
    button.textContent = `${state.running ? "⏸" : "▶"} ${mode} ${minutes}:${seconds}`;
  }

  /** 画风直选菜单：一步选中目标画风，替代旧的循环切换。 */
  showArtStyleMenu(event: MouseEvent): void {
    const styles = [
      { key: "lake", label: t("像素湖面") },
      { key: "ink", label: t("水墨山水") },
      { key: "city", label: t("像素城市") },
    ] as const;
    const menu = new Menu();
    for (const style of styles) {
      menu.addItem((item) => {
        item
          .setTitle(style.label)
          .setChecked(this.plugin.store.settings.artStyle === style.key)
          .onClick(() => {
            this.plugin.store.settings.artStyle = style.key;
            void this.plugin.saveSettings();
            this.render();
          });
      });
    }
    menu.showAtMouseEvent(event);
  }
}
