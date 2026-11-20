/** 智能体工坊页签的渲染逻辑。所有共享状态/方法通过 view 访问。 */
import { Notice, TFile } from "obsidian";
import { DiffModal } from "../../../ui/diff-modal";
import { DraftPreviewModal } from "../../../ui/draft-preview-modal";
import { listBackups, readBackup, restoreBackup } from "../../../features/audit";
import { localStamp } from "../../../utils/dates";
import { t, tf } from "../../../i18n";
import type { DashboardView } from "../../dashboard-view";

export function renderAgentHub(view: DashboardView, root: HTMLElement): void {
  const body = root.createDiv({ cls: "sd-body" });
  renderDrafts(view, body);
  view.renderTasksCard(body);
  renderAgentChanges(view, body);
  renderWorkLogs(view, body);
  const secondary = body.createDiv({ cls: "sd-secondary sd-agent-secondary" });
  renderAgentStatus(view, secondary);
  view.renderFooter(body);
}

export function renderAgentChanges(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("Agent 变更审查") });
  const seen = new Set<string>();
  const calls = view.plugin.store.data.toolCalls
    .filter((call) => call.tool.startsWith("POST "))
    .filter((call) => {
      if (!call.path || seen.has(call.path)) return false;
      seen.add(call.path);
      return true;
    })
    .filter((call) => /\.(md|json)$/.test(call.path))
    .filter((call) => !view.plugin.store.data.reviewedChanges[`${call.time}|${call.path}`])
    .slice(0, 8);

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

export async function openTaskSource(view: DashboardView, path?: string, line?: number): Promise<void> {
  if (!path) return;
  await view.plugin.app.workspace.openLinkText(path, "", false);
  if (line) {
    const editor = view.plugin.app.workspace.activeEditor?.editor;
    editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
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

export function renderDrafts(view: DashboardView, root: HTMLElement): void {
  const card = root.createDiv({ cls: "sd-card" });
  card.createDiv({ cls: "sd-card-title", text: t("AI 沉淀审核") });
  const modeLabels: Record<string, string> = {
    readonly: t("只读"),
    draft: t("草稿"),
    confirm: t("确认后写入"),
    auto: t("自动执行"),
  };
  card.createDiv({
    cls: "sd-card-sub",
    text: t("当前工作模式：") + (modeLabels[view.plugin.store.settings.agentWorkMode] ?? "confirm") +
      t("。草稿需手动审核；设为「自动执行」可跳过确认，但高风险操作仍会要求确认。"),
  });
  const drafts: TFile[] = [];
  for (const file of view.plugin.app.vault.getMarkdownFiles()) {
    const cache = view.plugin.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.sediment_status === "draft") drafts.push(file);
  }
  if (drafts.length === 0) {
    card.createDiv({ cls: "sd-empty", text: t("没有待审核的 AI 草稿。") });
    return;
  }
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
      void view.plugin.agentApi.updateFrontmatter(file.path, { sediment_status: "accepted" }).then(() => {
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
