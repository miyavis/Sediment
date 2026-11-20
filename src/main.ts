import { addIcon, Notice, Plugin, TFile, WorkspaceSidedock, type WorkspaceLeaf, type WorkspaceParent } from "obsidian";
import { AgentApi, generateToken } from "./agent/api";
import { AgentServer } from "./agent/server";
import { SemanticIndex } from "./agent/semantic";
import { Store } from "./data/store";
import { MemoManager } from "./features/memo";
import { PomodoroManager } from "./features/pomodoro";
import { TaskManager } from "./features/tasks";
import { exportTodayReport, heatmapSvg, parseEmbedOptions, todayLine } from "./features/embed";
import { buildWeeklyReview } from "./features/review";
import { rebuildHistory } from "./features/rebuild";
import { QuickMemoModal } from "./ui/quick-memo-modal";
import { HealthModal } from "./ui/health-modal";
import { ExportModal } from "./ui/export-modal";
import { DiagnosticsModal } from "./ui/diagnostics-modal";
import { McpUninstallModal } from "./ui/mcp-uninstall-modal";
import { PulseSettingTab } from "./ui/settings-tab";
import { ChangelogModal } from "./ui/changelog-modal";
import { SEDIMENT_ICON_ID, SEDIMENT_ICON_SVG } from "./ui/logo";
import { normalizeFolder, ensureFolder } from "./utils/vault";
import { addDays, dateKey, isSameLocalDay, parseKey, startOfWeek } from "./utils/dates";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./views/dashboard-view";
import { MemoView, MEMO_VIEW_TYPE } from "./views/memo-view";
import { Tracker } from "./tracking/tracker";
import { resolveLocale, setLocale, t, tf } from "./i18n";

export class SedimentPlugin extends Plugin {
  store!: Store;
  tracker!: Tracker;
  memos!: MemoManager;
  pomodoro!: PomodoroManager;
  tasks!: TaskManager;
  agentApi!: AgentApi;
  agentServer!: AgentServer;
  semantic!: SemanticIndex;

  async onload(): Promise<void> {
    addIcon(SEDIMENT_ICON_ID, SEDIMENT_ICON_SVG);
    this.store = new Store(this);
    await this.store.load();
    if (this.store.migrationWarning) {
      new Notice(this.store.migrationWarning);
    }
    setLocale(resolveLocale(this.store.settings.language));
    if (this.store.settings.lastSeenVersion !== this.manifest.version) {
      this.store.settings.lastSeenVersion = this.manifest.version;
      await this.store.save();
      new Notice(tf("Sediment 已更新到 v{version}，可在「查看更新记录」中了解变化", { version: this.manifest.version }));
    }
    if (!this.store.settings.agentServerToken) {
      this.store.settings.agentServerToken = generateToken();
      await this.store.save();
    }
    this.tracker = new Tracker(this, this.store);
    this.memos = new MemoManager(this);
    this.pomodoro = new PomodoroManager(this);
    this.tasks = new TaskManager(this);
    this.agentApi = new AgentApi(this);
    this.agentServer = new AgentServer(this);
    this.semantic = new SemanticIndex(this);

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.registerView(MEMO_VIEW_TYPE, (leaf) => new MemoView(leaf, this));

    this.registerMarkdownCodeBlockProcessor("sediment-heatmap", (source, element) => {
      const options = parseEmbedOptions(source);
      element.createDiv({ cls: "sd-embed" }).innerHTML = heatmapSvg(this.store, options);
    });
    this.registerMarkdownCodeBlockProcessor("sediment-today", (_source, element) => {
      element.createDiv({ cls: "sd-embed-today", text: todayLine(this.store) });
    });

    await this.tracker.start();

    // Agent 通过 MCP 写入笔记后，自动刷新看板与速记面板。
    const vault = this.app.vault;
    const onVaultChange = (path: string): void => {
      this.semantic.invalidate();
      this.scheduleRefresh(path);
    };
    this.registerEvent(vault.on("create", (file) => onVaultChange(file.path)));
    this.registerEvent(vault.on("modify", (file) => onVaultChange(file.path)));
    this.registerEvent(vault.on("delete", (file) => onVaultChange(file.path)));
    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        onVaultChange(file.path);
        onVaultChange(oldPath);
      })
    );

    await this.agentServer.applySettings();

    this.registerObsidianProtocolHandler("sediment", (params) => {
      void this.handleProtocol(params);
    });

    (window as Window & { Sediment?: unknown }).Sediment = {
      api: this.agentApi,
      store: this.store,
      memos: this.memos,
      pomodoro: this.pomodoro,
      tasks: this.tasks,
      plugin: this,
    };

    this.addRibbonIcon(SEDIMENT_ICON_ID, t("Sediment：看板"), () => {
      void this.activateView(DASHBOARD_VIEW_TYPE);
    });
    this.addRibbonIcon(SEDIMENT_ICON_ID, t("Sediment：速记"), () => {
      void this.activateView(MEMO_VIEW_TYPE);
    });

    this.registerCommands();
    this.addSettingTab(new PulseSettingTab(this.app, this));
  }

  /** 集中注册全部命令，避免 onload 过长。 */
  private registerCommands(): void {
    this.addCommand({
      id: "open-dashboard",
      name: t("打开知识脉冲看板"),
      callback: () => void this.activateView(DASHBOARD_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-memos",
      name: t("打开速记面板"),
      callback: () => void this.activateView(MEMO_VIEW_TYPE),
    });
    this.addCommand({
      id: "quick-memo",
      name: t("记一条速记"),
      callback: () =>
        new QuickMemoModal(this.app, (text, tags) => void this.memos.add(text, tags)).open(),
    });
    this.addCommand({
      id: "weekly-review",
      name: t("生成本周工作复盘"),
      callback: () => void this.generateReview(),
    });
    this.addCommand({
      id: "pomodoro-toggle",
      name: t("开始 / 暂停番茄钟"),
      callback: () => this.pomodoro.toggle(),
    });
    this.addCommand({
      id: "pomodoro-skip",
      name: t("跳过当前番茄 / 休息"),
      callback: () => this.pomodoro.skip(),
    });
    this.addCommand({
      id: "snapshot-open-tasks",
      name: t("记录今日遗留待办到日记"),
      callback: () =>
        void this.tasks.snapshot().then((count) => {
          new Notice(count > 0 ? tf("已记录 {n} 条遗留待办", { n: count }) : t("没有遗留待办"));
        }),
    });
    this.addCommand({
      id: "export-today-report",
      name: t("导出今日战报图片"),
      callback: () => {
        const today = dateKey(new Date());
        const day = this.store.getDay(today);
        exportTodayReport({
          date: today,
          contribution: day.contribution,
          words: day.wordsAdded,
          streak: this.agentApi.getToday().streak,
          longest: this.longestDayStreak(),
          memos: this.store.data.memos.filter((memo) => memo.date === today).length,
          agentCalls: this.store.data.toolCalls.filter((call) => isSameLocalDay(call.time, today)).length,
        });
      },
    });
    this.addCommand({
      id: "backup-data",
      name: t("备份统计数据到库内"),
      callback: () =>
        void this.store.backupData(true).then((count) => {
          new Notice(count > 0 ? t("数据已备份到库内") : t("备份失败，请检查设置中的备份目录"));
        }),
    });
    this.addCommand({
      id: "rebuild-history",
      name: t("重建历史统计（按笔记日期补齐空日期）"),
      callback: () =>
        void rebuildHistory(this.store, this.app.vault).then((result) => {
          this.refreshViews();
          new Notice(
            result.filledDays > 0
              ? tf("已扫描 {scanned} 篇笔记，补齐 {days} 天（{notes} 篇 / {words} 词）", {
                  scanned: result.scanned,
                  days: result.filledDays,
                  notes: result.notes,
                  words: result.words,
                })
              : tf("扫描了 {scanned} 篇笔记，没有需要补齐的空日期", { scanned: result.scanned })
          );
        }),
    });
    this.addCommand({
      id: "note-health",
      name: t("扫描笔记健康度（孤儿/断链/久未更新）"),
      callback: () => new HealthModal(this.app, this).open(),
    });
    this.addCommand({
      id: "export-data",
      name: t("导出数据（CSV/JSON，默认脱敏）"),
      callback: () => new ExportModal(this.app, this).open(),
    });
    this.addCommand({
      id: "uninstall-mcp",
      name: "一键卸载 MCP 接入",
      callback: () => new McpUninstallModal(this).open(),
    });
    this.addCommand({
      id: "show-diagnostics",
      name: "查看诊断日志",
      callback: () => new DiagnosticsModal(this.app, this.store.data.diagnostics).open(),
    });
    this.addCommand({
      id: "show-changelog",
      name: t("查看更新记录"),
      callback: () => new ChangelogModal(this.app).open(),
    });
    this.addCommand({
      id: "cycle-art-style",
      name: t("切换看板顶部和底部的画风"),
      callback: () => {
        const styles = ["lake", "ink", "city"] as const;
        const current = this.store.settings.artStyle;
        this.store.settings.artStyle = styles[(styles.indexOf(current) + 1) % styles.length];
        void this.saveSettings();
        this.refreshViews();
      },
    });
  }

  private serverRestartTimer: number | null = null;
  private refreshTimer: number | null = null;

  async onunload(): Promise<void> {
    if (this.serverRestartTimer !== null) window.clearTimeout(this.serverRestartTimer);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.tracker?.stop();
    await this.agentServer?.stop();
    delete (window as Window & { Sediment?: unknown }).Sediment;
    await this.store.save();
  }

  async saveSettings(): Promise<void> {
    await this.store.save();
    if (this.serverRestartTimer !== null) window.clearTimeout(this.serverRestartTimer);
    this.serverRestartTimer = window.setTimeout(() => {
      this.serverRestartTimer = null;
      void this.agentServer.applySettings();
    }, 600);
  }

  /** obsidian://sediment?action=memo&text=...&tags=... */
  private async handleProtocol(params: Record<string, string>): Promise<void> {
    const action = (params.action ?? "").toLowerCase();
    if (action === "memo" && params.text) {
      const tags = (params.tags ?? "")
        .split(/[,\s]+/)
        .map((tag) => tag.replace(/^#/, ""))
        .filter(Boolean);
      await this.memos.add(params.text, tags);
      if (params.open === "1") await this.activateView(MEMO_VIEW_TYPE);
    } else if (action === "dashboard" || action === "open") {
      await this.activateView(DASHBOARD_VIEW_TYPE);
    }
  }

  refreshViews(soft = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      (leaf.view as DashboardView).render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(MEMO_VIEW_TYPE)) {
      const view = leaf.view as MemoView;
      if (soft) view.refreshContent();
      else view.render();
    }
  }

  private longestDayStreak(): number {
    const keys = Object.keys(this.store.data.days)
      .filter((key) => this.store.getDay(key).contribution > 0)
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

  /** Agent 写入知识库/速记后自动刷新面板，保留用户正在输入的内容。 */
  private scheduleRefresh(path: string): void {
    const folders = [
      normalizeFolder(this.store.settings.knowledgeFolder),
      normalizeFolder(this.store.settings.workLogFolder),
      normalizeFolder(this.store.settings.dailyNoteFolder),
    ].filter((folder) => folder.length > 0);
    if (!folders.some((folder) => path.startsWith(`${folder}/`))) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews(true);
    }, 400);
  }

  private async activateView(type: string): Promise<void> {
    const workspace = this.app.workspace;
    let leaf: WorkspaceLeaf | null = null;
    for (const candidate of workspace.getLeavesOfType(type)) {
      const side = this.isSideLeaf(candidate);
      if (type === DASHBOARD_VIEW_TYPE && side) {
        // 旧版把看板开在了右侧栏，关掉它，改到主区重新开一个。
        candidate.detach();
        continue;
      }
      if (type === DASHBOARD_VIEW_TYPE && leaf) {
        candidate.detach();
        continue;
      }
      if (!leaf) leaf = candidate;
    }
    if (!leaf) {
      // 看板始终用 root split 的新标签页；速记才放右侧栏。
      leaf =
        type === MEMO_VIEW_TYPE
          ? workspace.getRightLeaf(false) ?? (await workspace.getLeaf(true))
          : await workspace.getLeaf(true);
    }
    await leaf.setViewState({ type, active: true });
    void workspace.revealLeaf(leaf);
  }

  private isSideLeaf(leaf: WorkspaceLeaf): boolean {
    let parent = leaf.parent as unknown as WorkspaceParent | null;
    while (parent) {
      if (parent instanceof WorkspaceSidedock) return true;
      parent = (parent as { parent?: WorkspaceParent | null }).parent ?? null;
    }
    return false;
  }

  private async generateReview(): Promise<void> {
    const markdown = buildWeeklyReview(this.store, new Date());
    const weekStart = startOfWeek(new Date(), this.store.settings.weekStart);
    const folder = normalizeFolder(this.store.settings.reviewFolder);
    await ensureFolder(this.app.vault, folder);

    const name = `复盘 ${dateKey(weekStart)}.md`;
    const path = folder ? `${folder}/${name}` : name;
    const existing = this.app.vault.getAbstractFileByPath(path);

    let file: TFile;
    if (existing instanceof TFile) {
      const previous = await this.app.vault.read(existing);
      // 周复盘去重：文件已含本周区间标题则不再追加，直接打开已有复盘。
      const weekHeading = markdown.split("\n", 1)[0];
      if (previous.includes(weekHeading)) {
        await this.app.workspace.getLeaf(true).openFile(existing);
        new Notice(t("本周复盘已存在"));
        return;
      }
      await this.app.vault.modify(existing, `${previous.trimEnd()}\n\n---\n\n${markdown}`);
      file = existing;
    } else {
      file = await this.app.vault.create(path, markdown);
    }

    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(t("周复盘已生成并打开"));
  }
}

export default SedimentPlugin;
