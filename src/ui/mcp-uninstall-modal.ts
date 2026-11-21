import { Modal, Notice } from "obsidian";
import type { SedimentPlugin } from "../main";
import { listMcpInstallations, uninstallMcp } from "../features/uninstall";
import { t, tf } from "../i18n";

/** MCP 一键卸载：只清客户端配置与桥接脚本，不动笔记和统计数据。 */
export class McpUninstallModal extends Modal {
  constructor(private plugin: SedimentPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("sd-mcp-uninstall");
    contentEl.createEl("h2", { text: t("一键卸载 MCP 接入") });
    contentEl.createDiv({
      cls: "sd-card-sub",
      text: t("只移除智能体客户端里的 sediment 配置和库内桥接脚本；不会删除笔记、日记或统计数据。客户端配置会先备份为 .bak。"),
    });

    const state = listMcpInstallations(this.plugin);
    const selected = new Set<string>();
    const list = contentEl.createDiv({ cls: "sd-uninstall-list" });

    for (const client of state.clients) {
      if (!client.configured) continue;
      const row = list.createDiv({ cls: "sd-uninstall-row" });
      const label = row.createEl("label", { cls: "sd-uninstall-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      selected.add(client.id);
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(client.id);
        else selected.delete(client.id);
      };
      label.createSpan({ text: `${client.label} · ${client.configPath}` });
    }

    let bridgeChecked = state.bridgeExists;
    if (state.bridgeExists) {
      const row = list.createDiv({ cls: "sd-uninstall-row" });
      const label = row.createEl("label", { cls: "sd-uninstall-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      checkbox.onchange = () => {
        bridgeChecked = checkbox.checked;
      };
      label.createSpan({ text: tf("桥接脚本 · {path}", { path: state.bridgePath }) });
    }

    if (state.clients.every((client) => !client.configured) && !state.bridgeExists) {
      list.createDiv({ cls: "kp-empty", text: t("没有发现已接入的 MCP 配置或桥接脚本。") });
    }

    const actions = contentEl.createDiv({ cls: "sd-uninstall-actions" });
    actions.createEl("button", { text: t("取消") }).onclick = () => this.close();
    const execute = actions.createEl("button", { cls: "mod-warning", text: t("执行卸载") });
    execute.onclick = () => {
      const result = uninstallMcp(this.plugin, [...selected], bridgeChecked);
      const summary = tf("已移除 {n} 个客户端配置{bridge}。请重启对应客户端。", {
        n: result.clients,
        bridge: result.bridge ? t("，并删除桥接脚本") : "",
      });
      if (result.failures.length > 0) {
        new Notice(`${summary} ${tf("失败：{list}", { list: result.failures.join(t("；")) })}`);
      } else {
        new Notice(summary);
      }
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
