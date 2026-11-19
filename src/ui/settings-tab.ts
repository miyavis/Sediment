import { App, PluginSettingTab, Setting } from "obsidian";
import type { SedimentPlugin } from "../main";
import { generateToken } from "../agent/api";
import { METRICS, type MetricKey } from "../types";

export class PulseSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SedimentPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Sediment 设置" });

    const settings = this.plugin.store.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("日记文件夹")
      .setDesc("速记写入的目录，留空表示库根目录。")
      .addText((text) =>
        text
          .setPlaceholder("daily")
          .setValue(settings.dailyNoteFolder)
          .onChange((value) => {
            settings.dailyNoteFolder = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("日记文件名格式")
      .setDesc("支持 YYYY / MM / DD 占位符。")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(settings.dailyNoteFormat)
          .onChange((value) => {
            settings.dailyNoteFormat = value || "YYYY-MM-DD";
            save();
          })
      );

    new Setting(containerEl)
      .setName("速记段落标题")
      .addText((text) =>
        text
          .setPlaceholder("## 速记")
          .setValue(settings.memoHeading)
          .onChange((value) => {
            settings.memoHeading = value || "## 速记";
            save();
          })
      );

    new Setting(containerEl)
      .setName("每周起始日")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "周一")
          .addOption("0", "周日")
          .setValue(String(settings.weekStart))
          .onChange((value) => {
            settings.weekStart = value === "0" ? 0 : 1;
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("热力图默认指标")
      .addDropdown((dropdown) => {
        for (const metric of METRICS) dropdown.addOption(metric.key, metric.label);
        dropdown.setValue(settings.heatmapMetric).onChange((value) => {
          settings.heatmapMetric = value as MetricKey;
          save();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName("统计有效编辑会话")
      .setDesc("同一文件同一天最多记一次，避免连续键入刷分。")
      .addToggle((toggle) =>
        toggle.setValue(settings.trackEdits).onChange((value) => {
          settings.trackEdits = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName("复盘归档文件夹")
      .addText((text) =>
        text
          .setPlaceholder("reviews")
          .setValue(settings.reviewFolder)
          .onChange((value) => {
            settings.reviewFolder = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("Agent 工作日志目录")
      .setDesc("智能体每次工作的沉淀日志，默认按天写入一个文件。")
      .addText((text) =>
        text
          .setPlaceholder("agent-logs")
          .setValue(settings.workLogFolder)
          .onChange((value) => {
            settings.workLogFolder = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("知识沉淀目录")
      .setDesc("智能体通过 add_knowledge 写入的长期笔记目录。")
      .addText((text) =>
        text
          .setPlaceholder("knowledge")
          .setValue(settings.knowledgeFolder)
          .onChange((value) => {
            settings.knowledgeFolder = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("知识库分类")
      .setDesc("逗号分隔，智能体沉淀笔记时会按分类建子目录。")
      .addText((text) =>
        text
          .setPlaceholder("技术,项目,方法,灵感,复盘")
          .setValue(settings.knowledgeCategories)
          .onChange((value) => {
            settings.knowledgeCategories = value;
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("Agent 禁止访问的文件夹")
      .setDesc("逗号分隔；这些目录对 Agent 的读写和搜索全部隐藏。")
      .addText((text) =>
        text
          .setPlaceholder("例如：财务,私人日记")
          .setValue(settings.deniedFolders)
          .onChange((value) => {
            settings.deniedFolders = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("Agent 禁止访问的标签")
      .setDesc("逗号分隔；带这些标签的笔记对 Agent 不可读。")
      .addText((text) =>
        text
          .setPlaceholder("例如：私密,密码")
          .setValue(settings.deniedTags)
          .onChange((value) => {
            settings.deniedTags = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName("看板画风")
      .setDesc("像素湖面 / 水墨山水 / 像素城市，也可在看板页脚点「换画风」。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("lake", "像素湖面")
          .addOption("ink", "水墨山水")
          .addOption("city", "像素城市")
          .setValue(settings.artStyle)
          .onChange((value) => {
            settings.artStyle = value as "lake" | "ink" | "city";
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("每日写作目标")
      .setDesc("看板今天卡片显示进度，0 表示关闭。")
      .addText((text) =>
        text
          .setPlaceholder("1000")
          .setValue(String(settings.dailyWordGoal))
          .onChange((value) => {
            const goal = Number(value);
            settings.dailyWordGoal = Number.isFinite(goal) && goal >= 0 ? goal : 1000;
            save();
            this.plugin.refreshViews();
          })
      );

    containerEl.createEl("h3", { text: "Agent 接入（本地 HTTP / MCP）" });

    new Setting(containerEl)
      .setName("启用本地 Agent API")
      .setDesc("只监听 127.0.0.1，供 MCP 桥接和本地脚本调用个人知识库。")
      .addToggle((toggle) =>
        toggle.setValue(settings.agentServerEnabled).onChange((value) => {
          settings.agentServerEnabled = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName("端口")
      .setDesc("默认 27123，修改后服务会自动重启。")
      .addText((text) =>
        text
          .setPlaceholder("27123")
          .setValue(String(settings.agentServerPort))
          .onChange((value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port > 0 && port < 65536) {
              settings.agentServerPort = port;
              save();
            }
          })
      );

    new Setting(containerEl)
      .setName("访问令牌")
      .setDesc("HTTP 请求与 MCP 桥接都必须携带此令牌。")
      .addText((text) =>
        text
          .setPlaceholder("点击右侧按钮生成")
          .setValue(settings.agentServerToken)
          .onChange((value) => {
            settings.agentServerToken = value.trim();
            save();
          })
      );

    new Setting(containerEl)
      .setName("重新生成令牌")
      .setDesc("泄露或遗忘时点击，旧令牌立即失效。")
      .addButton((button) =>
        button.setButtonText("生成新令牌").onClick(() => {
          settings.agentServerToken = generateToken();
          save();
          this.display();
        })
      );
  }
}
