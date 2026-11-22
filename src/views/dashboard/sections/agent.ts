/** 智能体工坊页签：纯审核队列（草稿 + 待审写入 + 变更审查 + 数据恢复 + Agent 待办）。
 *  工作日志与连接状态已挪至今日页；页脚由 dashboard-view.render() 统一渲染。 */
import { Notice, TFile } from "obsidian";
import { DiffModal } from "../../../ui/diff-modal";
import { DraftPreviewModal } from "../../../ui/draft-preview-modal";
import { confirmAction } from "../../../ui/confirm-modal";
import { listBackupsMap, readBackup, restoreBackup } from "../../../features/audit";
import { buildChangeTimeline, type ChangeTimelineEvent } from "../../../features/change-timeline";
import { summarizeAgentUsage } from "../../../data/agent-usage";
import { localStamp } from "../../../utils/dates";
import { frontmatterOf, normalizeFolder } from "../../../utils/vault";
import { t, tf } from "../../../i18n";
import { pendingChangeRows } from "../review-queue";
import type { DashboardView } from "../../dashboard-view";

export function renderAgentHub(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  renderDrafts(view, body);
  renderPendingWrites(view, body);
  renderUnregisteredSources(view, body);
  renderAgentChanges(view, body);
  // 待办卡较短，放在长列表之前，避免被时间线顶到屏幕外。
  view.renderTasksCard(body, true);
  renderChangeTimeline(view, body);
}

/** confirm 档挂起的 Agent 写入：预览走 DiffModal，采纳才真正落盘。 */
export function renderPendingWrites(view: DashboardView, root: HTMLElement): void {
  const pending = view.plugin.store.data.pendingWrites ?? [];
  if (pending.length === 0 && view.plugin.store.settings.agentWorkMode !== "confirm") return;
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: tf("待审写入 · {n}", { n: pending.length }) });
  card.createDiv({ cls: "sd-card-sub", text: t("「确认后写入」档下，Agent 的写操作挂起在这里，采纳后才真正落盘；驳回则丢弃。") });
  card.createDiv({ cls: "sd-card-sub", text: t("文件若在挂起后被修改，采纳会因版本冲突失败；可驳回后让 Agent 重发。") });
  card.createDiv({ cls: "sd-card-sub", text: t("失效项（目标被删除/移动）只能驳回，让 Agent 重发。") });
  if (pending.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("没有挂起的待审写入。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const item of pending.slice(0, 20)) {
    const row = list.createDiv({ cls: "sd-feed-row sd-feed-row-audit" });
    row.createSpan({ text: `${localStamp(item.time).slice(5)} · ${item.agent} · ${item.path}`, attr: { title: item.path } });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    actions.createSpan({
      cls: "sd-audit-badge",
      text:
        item.source === "bridge"
          ? `${pendingToolLabel(item.tool)} · ${t("文件桥")}`
          : pendingToolLabel(item.tool),
    });
    if (item.stale) {
      actions.createSpan({ cls: "sd-audit-badge is-stale", text: t("目标已删除/移动") });
      actions.createEl("button", { cls: "mod-cta", text: t("驳回") }).onclick = () =>
        void rejectPendingWrite(view, item.id);
      continue;
    }
    actions.createEl("button", { cls: "mod-cta", text: t("预览并审批") }).onclick = () => {
      new DiffModal(
        view.plugin.app,
        `${item.path} · ${t("待审写入")}`,
        item.before,
        item.after,
        () => void rejectPendingWrite(view, item.id),
        () => void approvePendingWrite(view, item.id),
        {
          restore: t("驳回丢弃"),
          keep: t("采纳写入"),
          leftTitle: t("当前内容（未采纳）"),
          rightTitle: t("采纳后内容（未落盘）"),
        }
      ).open();
    };
    actions.createEl("button", { text: t("驳回") }).onclick = () => void rejectPendingWrite(view, item.id);
  }
}

const PENDING_TOOL_LABELS: Record<string, string> = {
  write_note: "新建/覆盖",
  patch_note: "局部修改",
  frontmatter: "属性",
  add_knowledge: "沉淀",
  add_memo: "速记",
  record_work_log: "工作日志",
  complete_task: "勾选待办",
  snapshot_tasks: "遗留待办快照",
  delegate_task: "转交待办",
};

function pendingToolLabel(tool: string): string {
  const zh = PENDING_TOOL_LABELS[tool];
  return zh ? t(zh) : tool;
}

async function approvePendingWrite(view: DashboardView, id: string): Promise<void> {
  try {
    await view.plugin.agentApi.approvePendingWrite(id);
    new Notice(t("已采纳，写入已落盘"));
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
  view.render();
}

async function rejectPendingWrite(view: DashboardView, id: string): Promise<void> {
  try {
    view.plugin.agentApi.rejectPendingWrite(id);
    new Notice(t("已驳回，未写入任何内容"));
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
  view.render();
}

/** 来源未登记：知识目录内没有 source 属性的笔记（绕过 MCP 直写/手动新建的中性呈现）。 */
export function renderUnregisteredSources(view: DashboardView, root: HTMLElement): void {
  const plugin = view.plugin;
  // 空目录会被扫描器当成「整个库」，清空设置时会把全库笔记列成未登记，故直接不渲染。
  const knowledgeFolder = normalizeFolder(plugin.store.settings.knowledgeFolder);
  if (!knowledgeFolder) return;
  const state = view.agentScan();
  if (state.unregistered === 0) return;
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: tf("来源未登记 · {n}", { n: state.unregistered }) });
  card.createDiv({
    cls: "sd-card-sub",
    text: t("这些知识笔记没有 source 属性（可能来自绕过 MCP 的直写或手动新建）。标记为人工后计入人工来源；不改动正文。"),
  });
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const path of state.unregisteredPaths) {
    const row = list.createDiv({ cls: "sd-feed-row sd-feed-row-audit" });
    const open = row.createEl("button", { cls: "sd-knowledge-open", text: path });
    open.onclick = () => void plugin.app.workspace.openLinkText(path, "", false);
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    actions.createEl("button", { text: t("标记为人工") }).onclick = () => void markHumanSource(view, path);
  }
}

/** 用户亲自触发的登记动作：与草稿采纳同款 bypass 先例，仍过访问门禁。 */
async function markHumanSource(view: DashboardView, path: string): Promise<void> {
  try {
    await view.plugin.agentApi.updateFrontmatter(path, { source: "human" }, undefined, true);
    new Notice(t("已标记为人工来源"));
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
  view.render();
}

export function renderAgentChanges(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("Agent 变更审查") });
  const rows = pendingChangeRows(
    view.plugin.store.data.toolCalls,
    view.plugin.store.data.reviewedChanges,
    (path) => view.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile
  ).slice(0, 8);

  if (rows.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("暂无 Agent 变更记录。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  const backupsByPath = listBackupsMap(
    view.plugin,
    rows.filter((row) => !row.missing).map((row) => row.call.path)
  );
  for (const { call, missing } of rows) {
    const row = list.createDiv({ cls: "sd-feed-row sd-feed-row-audit" });
    row.createSpan({ text: `${localStamp(call.time).slice(5)} · ${call.tool.replace(/^(GET|POST) /, "")}`, attr: { title: call.path } });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    if (missing) {
      // 目标已删除/移动：保留一行让用户能手动了结，避免徽章计数与列表可见行漂移。
      actions.createSpan({ cls: "sd-audit-badge is-stale", text: t("目标已删除/移动") });
      actions.createSpan({ text: call.path.split("/").pop() ?? call.path, attr: { title: call.path } });
      actions.createEl("button", { text: t("标记已审查") }).onclick = () => {
        view.plugin.store.reviewChange(`${call.time}|${call.path}`, "kept");
        new Notice(t("已标记为已审查"));
        view.render();
      };
      continue;
    }
    const file = view.plugin.app.vault.getAbstractFileByPath(call.path);
    if (!(file instanceof TFile)) continue;
    const backups = backupsByPath.get(call.path) ?? [];
    const type = call.tool.includes("patch")
      ? t("局部修改")
      : call.tool.includes("frontmatter")
        ? t("属性")
        : call.tool.includes("knowledge")
          ? t("沉淀")
          : call.tool.includes("memo")
            ? t("速记")
            : t("新建/覆盖");
    actions.createSpan({ cls: "sd-audit-badge", text: type });
    const open = actions.createEl("button", { text: file.basename, cls: "sd-audit-open" });
    open.onclick = () => void view.plugin.app.workspace.openLinkText(call.path, "", false);
    if (backups.length > 0) {
      actions.createEl("button", { text: tf("差异({n})", { n: backups.length }) }).onclick = () => {
        void view.plugin.app.vault.read(file).then((current) => {
          new DiffModal(
            view.plugin.app,
            `${file.basename} · ${t("变更对比")}`,
            readBackup(view.plugin, backups[0].name),
            current,
            () => {
              void restoreBackup(view.plugin, file, backups[0].name).then(() => {
                view.plugin.store.reviewChange(`${call.time}|${call.path}`, "reverted");
                new Notice(t("已采用备份，本次 Agent 修改已撤销"));
                view.render();
              });
            },
            () => {
              view.plugin.store.reviewChange(`${call.time}|${call.path}`, "kept");
              new Notice(t("已标记为保留当前版本，本次变更不再待审"));
              view.render();
            }
          ).open();
        });
      };
      actions.createEl("button", { text: t("恢复") }).onclick = () => {
        void confirmAction(
          view.plugin.app,
          t("确认恢复这个 Agent 修改快照？当前笔记内容会被替换。")
        ).then((ok) => {
          if (!ok) return;
          void restoreBackup(view.plugin, file, backups[0].name).then(() => {
            view.plugin.store.reviewChange(`${call.time}|${call.path}`, "reverted");
            new Notice(t("已恢复到最近备份"));
            view.render();
          });
        });
      };
    } else {
      // 新建类写入没有旧快照可对比，但仍需结案入口，否则徽章只增不减。
      actions.createEl("button", { text: t("标记已审查") }).onclick = () => {
        view.plugin.store.reviewChange(`${call.time}|${call.path}`, "kept");
        new Notice(t("已标记为已审查"));
        view.render();
      };
    }
  }
}

/** 客户端 id → 展示名；未知 id 原样显示，空 id 归为「未署名客户端」。 */
const AGENT_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  cline: "Cline CLI",
  "cline-ide": "Cline (VS Code)",
  gemini: "Gemini CLI",
  windsurf: "Windsurf",
  "windsurf-next": "Windsurf Next",
};

export function agentLabel(agent: string): string {
  if (!agent || agent === "unknown") return t("未署名客户端");
  return AGENT_LABELS[agent] ?? agent;
}

/** 只重绘状态卡本体，供看板定时刷新（不触碰滚动位置与其它卡片）。 */
export function paintAgentStatus(view: DashboardView, card: HTMLElement): void {
  card.empty();
  card.createDiv({ cls: "sd-card-title", text: t("连接与调用状态") });
  const settings = view.plugin.store.settings;
  const now = Date.now();
  const usage = view.plugin.store.data.agentUsage ?? {};
  const agents = summarizeAgentUsage(usage, now);
  const total = agents.reduce((sum, agent) => sum + agent.total, 0);
  const last24h = agents.reduce((sum, agent) => sum + agent.last24h, 0);
  const last7d = agents.reduce((sum, agent) => sum + agent.last7d, 0);

  const grid = card.createDiv({ cls: "sd-status-grid" });
  const item = (label: string, value: string): void => {
    const box = grid.createDiv({ cls: "sd-status-item" });
    box.createDiv({ cls: "sd-mini-label", text: label });
    box.createDiv({ cls: "sd-mini-value", text: value });
  };
  item(t("本地 API"), settings.agentServerEnabled ? `${t("在线")} · ${settings.agentServerPort}` : t("未启用"));
  item(t("累计调用"), String(total));
  item(t("近 24 小时"), String(last24h));
  item(t("近 7 天"), String(last7d));

  card.createDiv({ cls: "sd-card-sub sd-agent-section-label", text: t("客户端") });
  if (agents.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("尚无 Agent 调用。客户端首次调用后会显示在这里。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-agent-rows" });
  for (const agent of agents) {
    const row = list.createDiv({ cls: "sd-agent-row" });
    if (agent.active) row.addClass("is-live");
    const head = row.createDiv({ cls: "sd-agent-head" });
    head.createSpan({ cls: "sd-agent-name", text: agentLabel(agent.agent) });
    if (agent.active) head.createSpan({ cls: "sd-agent-live", text: t("5 分钟内调用过") });
    head.createSpan({
      cls: "sd-agent-window",
      text: `${t("近 24 小时")} ${agent.last24h} · ${t("近 7 天")} ${agent.last7d} · ${tf("{n} 次", { n: agent.total })}`,
    });
    if (agent.lastAt) {
      row.createDiv({
        cls: "sd-agent-last",
        text: `${t("最近调用")}：${localStamp(agent.lastAt)}${agent.lastTool ? ` · ${agent.lastTool}` : ""}`,
      });
    }
  }
}

export function renderAgentStatus(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-agent-status-card" });
  paintAgentStatus(view, card);
}

/** 扫描 vault 中 sediment_status=draft 的笔记（徽章计数与草稿卡共用同一口径）。 */
export function listDraftFiles(view: DashboardView): TFile[] {
  return view.agentScan().drafts;
}

export function renderDrafts(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("AI 沉淀审核") });
  const modeLabels: Record<string, string> = {
    readonly: t("只读"),
    draft: t("草稿"),
    confirm: t("确认后写入"),
    auto: t("自动执行"),
  };
  card.createDiv({
    cls: "sd-card-sub",
    text: t("当前工作模式：") + (modeLabels[view.plugin.store.settings.agentWorkMode] ?? "confirm") +
      t("。草稿需手动审核；「确认后写入」档下 Agent 的写操作会挂起在「待审写入」列表，采纳后才落盘；「自动执行」档不挂起。"),
  });
  const drafts = view.agentScan().drafts;
  if (drafts.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("没有待审核的 AI 草稿。") });
    return;
  }
  // 截断展示时卡头给出总数，避免用户误以为只有 20 份。
  if (drafts.length > 20) head.createDiv({ cls: "sd-card-sub", text: tf("共 {n} 份草稿", { n: drafts.length }) });
  const list = card.createDiv({ cls: "sd-draft-list" });
  for (const file of drafts.slice(0, 20)) {
    const item = list.createDiv({ cls: "sd-draft-card" });
    const title = item.createEl("button", { cls: "sd-draft-title", text: file.basename });
    title.onclick = () => void view.plugin.app.workspace.openLinkText(file.path, "", false);
    const cache = view.plugin.app.metadataCache.getFileCache(file);
    const category = String(cache?.frontmatter?.category ?? t("未分类"));
    item.createDiv({ cls: "sd-card-sub", text: `${category} · ${file.path}` });
    const actions = item.createDiv({ cls: "sd-draft-actions" });
    actions.createEl("button", { text: t("查看原文") }).onclick = () => {
      void view.plugin.app.vault.read(file).then((content) => {
        new DraftPreviewModal(view.plugin.app, file.basename, content).open();
      });
    };
    actions.createEl("button", { text: t("采纳并归档") }).onclick = () => {
      // 与「驳回删除」「完成待办」一致：状态变更先二次确认，再绕过 confirm 挂起直接落盘。
      void confirmAction(view.plugin.app, t("确认采纳该草稿并归档？")).then((ok) => {
        if (!ok) return;
        void view.plugin.agentApi
          .updateFrontmatter(file.path, { sediment_status: "accepted" }, undefined, true)
          .then(() => {
            new Notice(t("已采纳"));
            view.render();
          });
      });
    };
    actions.createEl("button", { text: t("合并到关联笔记") }).onclick = () => void mergeDraft(view, file);
    actions.createEl("button", { text: t("驳回删除") }).onclick = () => {
      void confirmAction(
        view.plugin.app,
        t("确认驳回并移入回收站？草稿可在回收站恢复。")
      ).then((ok) => {
        if (!ok) return;
        void view.plugin.app.fileManager.trashFile(file).then(() => {
          new Notice(t("已驳回并移入回收站"));
          view.render();
        });
      });
    };
  }
}

export async function mergeDraft(view: DashboardView, file: TFile): Promise<void> {
  const cache = view.plugin.app.metadataCache.getFileCache(file);
  const links = frontmatterOf(cache)?.links;
  const first = Array.isArray(links) && links.length > 0 ? String(links[0]) : "";
  if (!first) {
    new Notice(t("这张草稿没有关联笔记，无法合并"));
    return;
  }
  const target = view.plugin.app.vault
    .getMarkdownFiles()
    .find((item) => item.basename === first || item.path === first);
  if (!target) {
    new Notice(tf("找不到关联笔记：{name}", { name: first }));
    return;
  }
  if (!(await confirmAction(view.plugin.app, t("合并后草稿将移入回收站，是否继续？")))) return;
  const source = await view.plugin.app.vault.read(file);
  const body = source.replace(/^---[\s\S]*?---\s*/, "");
  await view.plugin.app.vault.process(target, (data) => `${data.trimEnd()}\n\n${body.trim()}\n`);
  await view.plugin.app.fileManager.trashFile(file);
  new Notice(tf("已合并到 {name}", { name: target.basename }));
  view.render();
}

/** 数据快照恢复已挪至设置页备份分区（低频维护操作不占审核页），见 settings-tab.renderRecoveryList。 */

export function renderWorkLogs(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("智能体工作日志") });
  const logs = view.plugin.store.data.workLogs.slice(0, 10);
  if (logs.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("还没有工作日志。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const log of logs) {
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({ text: `${log.date} ${log.time} · ${log.agent}` });
    row.createEl("strong", { text: log.task });
  }
}

/** 变更时间线：调用 → 挂起 → 审批 → 快照，按 Agent / 路径过滤。 */
export function renderChangeTimeline(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card sd-timeline" });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("变更时间线") });
  head.createDiv({ cls: "sd-card-sub", text: t("谁、何时、改了什么、哈希、审批决定与快照，按时间倒序。") });

  const filter = card.createDiv({ cls: "sd-timeline-filter" });
  const agentInput = filter.createEl("input", {
    attr: { type: "text", placeholder: t("按 Agent 过滤"), "aria-label": t("按 Agent 过滤") },
  });
  const pathInput = filter.createEl("input", {
    attr: { type: "text", placeholder: t("按路径过滤"), "aria-label": t("按路径过滤") },
  });
  const readsLabel = filter.createEl("label", { cls: "sd-timeline-reads" });
  const readsToggle = readsLabel.createEl("input", { attr: { type: "checkbox" } });
  readsLabel.appendText(t("包含只读调用"));
  const list = card.createDiv({ cls: "sd-feed-list" });
  const more = card.createEl("button", { cls: "sd-timeline-more", text: t("显示更多") });

  const PAGE = 20;
  let shown = PAGE;
  const paint = (): void => {
    list.empty();
    const events = buildChangeTimeline(view.plugin.store.data, {
      limit: shown,
      agent: agentInput.value.trim() || undefined,
      path: pathInput.value.trim() || undefined,
      includeReads: readsToggle.checked,
    });
    if (events.length === 0) {
      list.createDiv({ cls: "sd-empty", text: t("暂无审计记录。") });
      more.hide();
      return;
    }
    for (const event of events) list.appendChild(timelineRow(event));
    const total = buildChangeTimeline(view.plugin.store.data, {
      includeReads: readsToggle.checked,
      agent: agentInput.value.trim() || undefined,
      path: pathInput.value.trim() || undefined,
      limit: 0,
    }).length;
    if (events.length < total) more.show(); else more.hide();
  };
  agentInput.oninput = () => { shown = PAGE; paint(); };
  pathInput.oninput = () => { shown = PAGE; paint(); };
  readsToggle.onchange = () => { shown = PAGE; paint(); };
  more.onclick = () => { shown += PAGE; paint(); };
  paint();
}

function timelineRow(event: ChangeTimelineEvent): HTMLElement {
  const row = document.createElement("div");
  row.className = "sd-feed-row sd-timeline-row";
  const badge = document.createElement("span");
  badge.className = `sd-audit-badge${event.status === "stale" ? " is-stale" : ""}`;
  badge.textContent = timelineBadge(event);
  row.appendChild(badge);
  const meta = document.createElement("span");
  meta.textContent = `${localStamp(event.time).slice(5)} · ${event.agent} · ${event.tool} · ${event.path || "—"}`;
  meta.setAttribute(
    "title",
    `${event.title}${event.hash ? ` · sha256:${event.hash.slice(0, 12)}` : ""}${event.snapshotId ? ` · snapshot:${event.snapshotId}` : ""}`
  );
  row.appendChild(meta);
  return row;
}

function timelineBadge(event: ChangeTimelineEvent): string {
  if (event.kind === "decision") return event.decision === "kept" ? t("保留") : t("撤销");
  if (event.kind === "snapshot") return t("快照");
  if (event.kind === "pending") return event.status === "stale" ? t("已失效") : t("待审");
  return t("调用");
}
