/** 智能体工坊页签：纯审核队列（草稿 + 待审写入 + 变更审查 + 数据恢复 + Agent 待办）。
 *  工作日志与连接状态已挪至今日页；页脚由 dashboard-view.render() 统一渲染。 */
import { Notice, TFile } from "obsidian";
import { DiffModal } from "../../../ui/diff-modal";
import { DraftPreviewModal } from "../../../ui/draft-preview-modal";
import { listBackups, readBackup, restoreBackup } from "../../../features/audit";
import { localStamp } from "../../../utils/dates";
import { t, tf } from "../../../i18n";
import { pendingReviewChanges } from "../review-queue";
import type { DashboardView } from "../../dashboard-view";

export function renderAgentHub(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  renderDrafts(view, body);
  renderPendingWrites(view, body);
  renderAgentChanges(view, body);
  renderDataRecovery(view, body);
  view.renderTasksCard(body, true);
}

/** confirm 档挂起的 Agent 写入：预览走 DiffModal，采纳才真正落盘。 */
export function renderPendingWrites(view: DashboardView, root: HTMLElement): void {
  const pending = view.plugin.store.data.pendingWrites ?? [];
  if (pending.length === 0 && view.plugin.store.settings.agentWorkMode !== "confirm") return;
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: tf("待审写入 · {n}", { n: pending.length }) });
  card.createDiv({ cls: "sd-card-sub", text: t("「确认后写入」档下，Agent 的写操作挂起在这里，采纳后才真正落盘；驳回则丢弃。") });
  card.createDiv({ cls: "sd-card-sub", text: t("文件若在挂起后被修改，采纳会因版本冲突失败；可驳回后让 Agent 重发。") });
  if (pending.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("没有挂起的待审写入。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const item of pending.slice(0, 20)) {
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({ text: `${localStamp(item.time).slice(5)} · ${item.agent} · ${item.path}` });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    actions.createSpan({ cls: "sd-audit-badge", text: pendingToolLabel(item.tool) });
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

export function renderAgentChanges(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("Agent 变更审查") });
  const calls = pendingReviewChanges(
    view.plugin.store.data.toolCalls,
    view.plugin.store.data.reviewedChanges
  ).slice(0, 8);

  if (calls.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("暂无 Agent 变更记录。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const call of calls) {
    const file = view.plugin.app.vault.getAbstractFileByPath(call.path);
    if (!(file instanceof TFile)) continue;
    const backups = listBackups(view.plugin, call.path);
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({ text: `${localStamp(call.time).slice(5)} · ${call.tool.replace(/^(GET|POST) /, "")}` });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
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
        if (!window.confirm(t("确认恢复这个 Agent 修改快照？当前笔记内容会被替换。"))) return;
        void restoreBackup(view.plugin, file, backups[0].name).then(() => {
          view.plugin.store.reviewChange(`${call.time}|${call.path}`, "reverted");
          new Notice(t("已恢复到最近备份"));
          view.render();
        });
      };
    }
  }
}

export function renderAgentStatus(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("连接与调用状态") });
  const settings = view.plugin.store.settings;
  const calls = view.plugin.store.data.toolCalls;
  const byAgent: Record<string, number> = {};
  for (const call of calls) byAgent[call.agent || "unknown"] = (byAgent[call.agent || "unknown"] ?? 0) + 1;
  const grid = card.createDiv({ cls: "sd-status-grid" });
  const item = (label: string, value: string): void => {
    const box = grid.createDiv({ cls: "sd-status-item" });
    box.createDiv({ cls: "sd-mini-label", text: label });
    box.createDiv({ cls: "sd-mini-value", text: value });
  };
  item(t("本地 API"), settings.agentServerEnabled ? `${t("在线")} · ${settings.agentServerPort}` : t("未启用"));
  item(t("累计调用"), String(calls.length));
  for (const [agent, count] of Object.entries(byAgent)) item(agent, tf("{n} 次", { n: count }));
  const last = calls[0];
  if (last) card.createDiv({ cls: "sd-card-sub", text: `${t("最近调用")}：${localStamp(last.time)} · ${last.tool}` });
}

/** 扫描 vault 中 sediment_status=draft 的笔记（徽章计数与草稿卡共用同一口径）。 */
export function listDraftFiles(view: DashboardView): TFile[] {
  const drafts: TFile[] = [];
  for (const file of view.plugin.app.vault.getMarkdownFiles()) {
    const cache = view.plugin.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.sediment_status === "draft") drafts.push(file);
  }
  return drafts;
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
  const drafts = listDraftFiles(view);
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
      // 人在看板上点「采纳」本身就是确认，绕过 confirm 挂起避免二次审批。
      void view.plugin.agentApi
        .updateFrontmatter(file.path, { sediment_status: "accepted" }, undefined, true)
        .then(() => {
          new Notice(t("已采纳"));
          view.render();
        });
    };
    actions.createEl("button", { text: t("合并到关联笔记") }).onclick = () => void mergeDraft(view, file);
    actions.createEl("button", { text: t("驳回删除") }).onclick = () => {
      if (!window.confirm(t("确认驳回并移入回收站？草稿可在回收站恢复。"))) return;
      void view.plugin.app.vault.trash(file, false).then(() => {
        new Notice(t("已驳回并移入回收站"));
        view.render();
      });
    };
  }
}

export async function mergeDraft(view: DashboardView, file: TFile): Promise<void> {
  const cache = view.plugin.app.metadataCache.getFileCache(file);
  const links = cache?.frontmatter?.links;
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
  if (!window.confirm(t("合并后草稿将移入回收站，是否继续？"))) return;
  const source = await view.plugin.app.vault.read(file);
  const body = source.replace(/^---[\s\S]*?---\s*/, "");
  await view.plugin.app.vault.process(target, (data) => `${data.trimEnd()}\n\n${body.trim()}\n`);
  await view.plugin.app.vault.trash(file, false);
  new Notice(tf("已合并到 {name}", { name: target.basename }));
  view.render();
}

/** 数据快照恢复：列出 data.json 备份并一键恢复（Task 5 API）。
 *  恢复是重操作：先二次确认；恢复副本写入失败（recovery="failed"）必须显著告警，
 *  全新安装无当前数据（recovery="none"）则正常提示，不误报失败。 */
export function renderDataRecovery(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("数据快照恢复") });
  card.createDiv({
    cls: "sd-card-sub",
    text: t("列出备份目录中的 data.json 快照，可一键恢复统计数据。恢复前会先把当前数据另存为恢复副本，恢复错了也能回退。"),
  });
  card.createDiv({
    cls: "sd-card-sub",
    text: t("备份目录为库根目录时，列表可能混入你自己创建的 data-*.json；恢复前会校验内容格式，损坏或非本插件数据会被拒绝。"),
  });
  if (view.plugin.store.isPersistenceBlocked) {
    card.createDiv({
      cls: "sd-card-sub sd-recovery-warning",
      text: t("数据写入已暂停以保护原始数据；恢复一份有效快照可解除暂停。"),
    });
  }
  const backups = view.plugin.store.listDataBackups();
  if (backups.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("还没有数据备份。开启「自动备份统计数据」后，快照会出现在这里。") });
    return;
  }
  const list = card.createDiv({ cls: "sd-feed-list" });
  for (const backup of backups.slice(0, 20)) {
    const row = list.createDiv({ cls: "sd-feed-row" });
    row.createSpan({
      text: `${backup.name} · ${localStamp(new Date(backup.savedAt).toISOString())} · ${(backup.size / 1024).toFixed(1)} KB`,
    });
    const actions = row.createDiv({ cls: "sd-audit-actions" });
    actions.createEl("button", { text: t("恢复") }).onclick = () => {
      if (!window.confirm(t("确认从该快照恢复统计数据？当前数据会先另存为恢复副本，恢复后看板立即重载。"))) return;
      void view.plugin.store.restoreDataBackup(backup.name).then((result) => {
        if (result.recovery === "failed") {
          // 恢复副本创建失败：备份已写回但失去回退保险，必须显著告警。
          new Notice(t("恢复副本创建失败：备份已恢复，但当前数据未能另存副本。请立即手动备份 data.json，避免再次恢复时无法回退。"), 15_000);
        } else if (result.recovery === "none") {
          // 全新安装没有当前数据可备份：无需恢复副本，不是失败。
          new Notice(tf("已从 {name} 恢复（此前无数据，无需恢复副本）", { name: backup.name }));
        } else {
          new Notice(tf("已从 {name} 恢复，恢复副本：{path}", { name: backup.name, path: result.recoveryPath }));
        }
        view.plugin.refreshViews();
      }).catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    };
  }
}

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
