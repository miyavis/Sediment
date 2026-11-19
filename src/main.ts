import { Notice, Plugin, TFile, WorkspaceSidedock, type WorkspaceLeaf, type WorkspaceParent } from "obsidian";
import { AgentApi, generateToken } from "./agent/api";
import { AgentServer } from "./agent/server";
import { Store } from "./data/store";
import { MemoManager } from "./features/memo";
import { PomodoroManager } from "./features/pomodoro";
import { buildWeeklyReview } from "./features/review";
import { QuickMemoModal } from "./ui/quick-memo-modal";
import { PulseSettingTab } from "./ui/settings-tab";
import { normalizeFolder, ensureFolder } from "./utils/vault";
import { dateKey, startOfWeek } from "./utils/dates";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./views/dashboard-view";
import { MemoView, MEMO_VIEW_TYPE } from "./views/memo-view";
import { Tracker } from "./tracking/tracker";

export class SedimentPlugin extends Plugin {
  store!: Store;
  tracker!: Tracker;
  memos!: MemoManager;
  pomodoro!: PomodoroManager;
  agentApi!: AgentApi;
  agentServer!: AgentServer;

  async onload(): Promise<void> {
    this.store = new Store(this);
    await this.store.load();
    if (!this.store.settings.agentServerToken) {
      this.store.settings.agentServerToken = generateToken();
      await this.store.save();
    }
    this.tracker = new Tracker(this, this.store);
    this.memos = new MemoManager(this);
    this.pomodoro = new PomodoroManager(this);
    this.agentApi = new AgentApi(this);
    this.agentServer = new AgentServer(this);

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.registerView(MEMO_VIEW_TYPE, (leaf) => new MemoView(leaf, this));

    await this.tracker.start();

    // Agent 通过 MCP 写入笔记后，自动刷新看板与速记面板。
    const vault = this.app.vault;
    this.registerEvent(vault.on("create", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(vault.on("modify", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(vault.on("delete", (file) => this.scheduleRefresh(file.path)));
    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        this.scheduleRefresh(file.path);
        this.scheduleRefresh(oldPath);
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
      plugin: this,
    };

    this.addRibbonIcon("activity", "Sediment：看板", () => {
      void this.activateView(DASHBOARD_VIEW_TYPE);
    });
    this.addRibbonIcon("sticky-note", "Sediment：速记", () => {
      void this.activateView(MEMO_VIEW_TYPE);
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开知识脉冲看板",
      callback: () => void this.activateView(DASHBOARD_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-memos",
      name: "打开速记面板",
      callback: () => void this.activateView(MEMO_VIEW_TYPE),
    });
    this.addCommand({
      id: "quick-memo",
      name: "记一条速记",
      callback: () =>
        new QuickMemoModal(this.app, (text, tags) => void this.memos.add(text, tags)).open(),
    });
    this.addCommand({
      id: "weekly-review",
      name: "生成本周工作复盘",
      callback: () => void this.generateReview(),
    });
    this.addCommand({
      id: "pomodoro-toggle",
      name: "开始 / 暂停番茄钟",
      callback: () => this.pomodoro.toggle(),
    });
    this.addCommand({
      id: "pomodoro-skip",
      name: "跳过当前番茄 / 休息",
      callback: () => this.pomodoro.skip(),
    });
    this.addCommand({
      id: "cycle-art-style",
      name: "切换看板顶部和底部的画风",
      callback: () => {
        const styles = ["lake", "ink", "city"] as const;
        const current = this.store.settings.artStyle;
        this.store.settings.artStyle = styles[(styles.indexOf(current) + 1) % styles.length];
        void this.saveSettings();
        this.refreshViews();
      },
    });

    this.addSettingTab(new PulseSettingTab(this.app, this));
  }

  private serverRestartTimer: number | null = null;
  private refreshTimer: number | null = null;

  async onunload(): Promise<void> {
    if (this.serverRestartTimer !== null) window.clearTimeout(this.serverRestartTimer);
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
      await this.app.vault.modify(existing, `${previous.trimEnd()}\n\n---\n\n${markdown}`);
      file = existing;
    } else {
      file = await this.app.vault.create(path, markdown);
    }

    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice("周复盘已生成并打开");
  }
}

export default SedimentPlugin;
