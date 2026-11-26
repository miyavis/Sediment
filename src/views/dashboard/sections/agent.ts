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
import { pendingChangeRows, recentChangeRows } from "../review-queue";
import type { DashboardView } from "../../dashboard-view";
import { WORK_MODE_LABELS } from "../../../agent/work-mode";

export function renderAgentHub(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  const data = view.plugin.store.data;
  const drafts = view.agentScan().drafts.length;
  const pending = data.pendingWrites?.length ?? 0;
  const changes = pendingChangeRows(
    data.toolCalls,
    data.reviewedChanges,
    (path) => view.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile
  ).length;
  const tasks = (data.memos ?? []).filter(
    (memo) => memo.tags.includes("to-agent") && !memo.converted && !memo.archived
  ).length;

  // 紧凑状态条始终显示：作为审计队列总览，避免 0→1 项时的高度跳动。
  const strip = body.createDiv({ cls: "sd-audit-strip sd-audit-strip-workshop" });
  strip.createSpan({ cls: "sd-audit-strip-title", text: t("审核队列") });
  strip.createSpan({
    text: `${t("草稿")} ${drafts} · ${t("待审写入")} ${pending} · ${t("变更审查")} ${changes} · ${t("Agent 待办")} ${tasks}`,
  });
  strip.createSpan({
    cls: "sd-audit-strip-open",
    text: drafts + pending + changes + tasks === 0
      ? t("Agent 写入会在这里等待你的审查。")
      : t("在下方卡片中逐条审查"),
  });

  // 所有审核卡始终渲染（含空状态），让用户一眼看到四个队列的当前状态。
  renderDrafts(view, body);
  renderPendingWrites(view, body);
  renderAgentChanges(view, body);
  // 待办卡较短，放在长列表之前，避免被时间线顶到屏幕外。
  view.renderTasksCard(body, true);
  renderUnregisteredSources(view, body);
  renderAgentStatus(view, body);
  renderChangeTimeline(view, body);
}

/** 空队列也保留卡片骨架，避免「没数据就什么都不显示」的突兀感；用紧凑样式少占空间。 */
function auditEmptyCard(root: HTMLElement, title: string, message: string): void {
  const card = root.createDiv({ cls: "sd-card sd-card-empty" });
  card.createDiv({ cls: "sd-card-title", text: title });
  card.createDiv({ cls: "sd-card-sub", text: message });
}

/** confirm 档挂起的 Agent 写入：预览走 DiffModal，采纳才真正落盘。 */
export function renderPendingWrites(view: DashboardView, root: HTMLElement): void {
  const pending = view.plugin.store.data.pendingWrites ?? [];
  if (pending.length === 0) {
    auditEmptyCard(root, t("待审写入"), t("暂无待审写入；「确认后写入」档下的写操作会挂起在这里。"));
    return;
  }
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: tf("待审写入 · {n}", { n: pending.length }) });
  card.createDiv({ cls: "sd-card-sub", text: t("「确认后写入」档下，Agent 的写操作挂起在这里，采纳后才真正落盘；驳回则丢弃。") });
  card.createDiv({ cls: "sd-card-sub", text: t("文件若在挂起后被修改，采纳会因版本冲突失败；可驳回后让 Agent 重发。") });
  card.createDiv({ cls: "sd-card-sub", text: t("失效项（目标被删除/移动）只能驳回，让 Agent 重发。") });
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
      // 启动索引未就绪可能误标 stale，给用户一个就地复核入口。
      actions.createEl("button", { text: t("重新检查") }).onclick = () => {
        void view.plugin.store.revalidatePendingStale(item.id).then((ok) => {
          new Notice(t(ok ? "目标仍在且内容未变，已恢复待审" : "目标仍不可用，无法恢复"));
          view.render();
        });
      };
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
  // 防御：界面只在未登记时给出按钮，但若元数据已变化，绝不覆盖已有来源值。
  const file = view.plugin.app.vault.getAbstractFileByPath(path);
  const cache = file instanceof TFile ? view.plugin.app.metadataCache.getFileCache(file) : null;
  const existing = frontmatterOf(cache)?.source;
  const existingSource = typeof existing === "string" ? existing.trim() : "";
  if (existingSource && existingSource !== "human") {
    new Notice(t("该笔记已有来源信息，未覆盖"));
    return;
  }
  try {
    await view.plugin.agentApi.updateFrontmatter(path, { source: "human" }, undefined, true);
    new Notice(t("已标记为人工来源"));
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
  view.render();
}

export function renderAgentChanges(view: DashboardView, root: HTMLElement): void {
  const rows = recentChangeRows(
    view.plugin.store.data.toolCalls,
    view.plugin.store.data.reviewedChanges,
    (path) => view.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile
  ).slice(0, 8);
  if (rows.length === 0) {
    auditEmptyCard(root, t("Agent 变更审查"), t("暂无待审查的变更；Agent 的写入记录会出现在这里。"));
    return;
  }

  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("Agent 变更审查") });
  card.createDiv({ cls: "sd-card-sub", text: t("已审查项仅为变更记录，无需处理；差异与恢复仅供事后追溯，不计入待审。") });
  const list = card.createDiv({ cls: "sd-feed-list" });
  const backupsByPath = listBackupsMap(
    view.plugin,
    rows.filter((row) => !row.missing).map((row) => row.call.path)
  );
  for (const { call, missing, reviewed } of rows) {
    const row = list.createDiv({ cls: "sd-feed-row sd-feed-row-audit" });
    row.createSpan({ text: `${localStamp(call.time).slice(5)} · ${call.tool.replace(/^(GET|POST) /, "")}`, attr: { title: call.path } });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    if (reviewed) {
      actions.createSpan({
        cls: "sd-audit-badge is-done",
        text: t("已审查"),
        attr: { title: t("审批已完成，无需操作；这里只作变更记录，差异/恢复可事后回溯") },
      });
    }
    if (missing) {
      // 目标已删除/移动：保留一行让用户能手动了结，避免徽章计数与列表可见行漂移。
      if (!reviewed) actions.createSpan({ cls: "sd-audit-badge is-stale", text: t("目标已删除/移动") });
      actions.createSpan({ text: call.path.split("/").pop() ?? call.path, attr: { title: call.path } });
      if (!reviewed) {
        actions.createEl("button", { text: t("标记已审查") }).onclick = () => {
          view.plugin.store.reviewChange(`${call.time}|${call.path}`, "kept");
          new Notice(t("已标记为已审查"));
          view.render();
        };
      }
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
    } else if (!reviewed) {
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
  const drafts = view.agentScan().drafts;
  if (drafts.length === 0) {
    auditEmptyCard(root, t("AI 沉淀审核"), t("暂无草稿；Agent 产出的沉淀会进入这里等待审核。"));
    return;
  }
  const card = root.createDiv({ cls: "sd-card" });
  const head = card.createDiv({ cls: "sd-card-head" });
  head.createDiv({ cls: "sd-card-title", text: t("AI 沉淀审核") });
  const mode = view.plugin.store.settings.agentWorkMode;
  card.createDiv({
    cls: "sd-card-sub",
    text: t("当前工作模式：") + (WORK_MODE_LABELS[mode] ? t(WORK_MODE_LABELS[mode]) : mode) +
      t("。草稿需手动审核；「确认后写入」档下 Agent 的写操作会挂起在「待审写入」列表，采纳后才落盘；「自动执行」档不挂起。"),
  });
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
  const logs = view.plugin.store.data.workLogs.slice(0, 10);
  // 空状态用紧凑卡样式，与工坊审核卡保持一致；有日志时走正常卡片。
  const card = root.createDiv({ cls: logs.length === 0 ? "sd-card sd-card-empty" : "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("智能体工作日志") });
  if (logs.length === 0) {
    card.createDiv({ cls: "sd-card-sub", text: t("还没有工作日志。") });
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
    for (const event of events) timelineRow(list, event);
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

function timelineRow(parent: HTMLElement, event: ChangeTimelineEvent): HTMLElement {
  const row = parent.createDiv({ cls: "sd-feed-row sd-timeline-row" });
  row.createSpan({
    cls: `sd-audit-badge${event.status === "stale" ? " is-stale" : ""}`,
    text: timelineBadge(event),
  });
  const meta = row.createSpan({
    text: `${localStamp(event.time).slice(5)} · ${event.agent} · ${event.tool} · ${event.path || "—"}`,
  });
  meta.setAttribute(
    "title",
    `${event.title}${event.hash ? ` · sha256:${event.hash.slice(0, 12)}` : ""}${event.snapshotId ? ` · snapshot:${event.snapshotId}` : ""}`
  );
  return row;
}

function timelineBadge(event: ChangeTimelineEvent): string {
  if (event.kind === "decision") return event.decision === "kept" ? t("保留") : t("撤销");
  if (event.kind === "snapshot") return t("快照");
  if (event.kind === "pending") return event.status === "stale" ? t("已失效") : t("待审");
  return t("调用");
}
