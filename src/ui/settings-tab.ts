import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { configureAgent, configSnippet, detectAgents, isAgentConfigured } from "../agent/setup";
import type { SedimentPlugin } from "../main";
import { generateToken } from "../agent/api";
import { METRICS, type MetricKey } from "../types";
import { resolveLocale, setLocale, t } from "../i18n";

export class PulseSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SedimentPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("Sediment 设置") });

    const settings = this.plugin.store.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName(t("界面语言"))
      .setDesc(t("跟随 Obsidian（auto），或强制中文 / 英文。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("跟随系统"))
          .addOption("zh", t("中文"))
          .addOption("en", t("英文"))
          .setValue(settings.language)
          .onChange((value) => {
            settings.language = value as "auto" | "zh" | "en";
            setLocale(resolveLocale(settings.language));
            save();
            this.plugin.refreshViews();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t("日记文件夹"))
      .setDesc(t("速记写入的目录，留空表示库根目录。"))
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
      .setName(t("日记文件名格式"))
      .setDesc(t("支持 YYYY / MM / DD 占位符。"))
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
      .setName(t("速记段落标题"))
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
      .setName(t("每周起始日"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", t("周一"))
          .addOption("0", t("周日"))
          .setValue(String(settings.weekStart))
          .onChange((value) => {
            settings.weekStart = value === "0" ? 0 : 1;
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("热力图默认指标"))
      .addDropdown((dropdown) => {
        for (const metric of METRICS) dropdown.addOption(metric.key, t(metric.label));
        dropdown.setValue(settings.heatmapMetric).onChange((value) => {
          settings.heatmapMetric = value as MetricKey;
          save();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName(t("统计有效编辑会话"))
      .setDesc(t("同一文件同一天最多记一次，避免连续键入刷分。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.trackEdits).onChange((value) => {
          settings.trackEdits = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("复盘归档文件夹"))
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
      .setName(t("Agent 工作日志目录"))
      .setDesc(t("智能体每次工作的沉淀日志，默认按天写入一个文件。"))
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
      .setName(t("知识沉淀目录"))
      .setDesc(t("智能体通过 add_knowledge 写入的长期笔记目录。"))
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
      .setName(t("知识库分类"))
      .setDesc(t("逗号分隔，智能体沉淀笔记时会按分类建子目录。"))
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
      .setName(t("Agent 禁止访问的文件夹"))
      .setDesc(t("逗号分隔；这些目录对 Agent 的读写和搜索全部隐藏。"))
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
      .setName(t("Agent 禁止访问的标签"))
      .setDesc(t("逗号分隔；带这些标签的笔记对 Agent 不可读。"))
      .addText((text) =>
        text
          .setPlaceholder("例如：私密,密码")
          .setValue(settings.deniedTags)
          .onChange((value) => {
            settings.deniedTags = value;
            save();
          })
      );

    containerEl.createEl("h3", { text: t("Agent 权限（可选）") });

    new Setting(containerEl)
      .setName(t("访问模式"))
      .setDesc(t("allowlist 模式下 Agent 只能访问下方白名单目录。默认全库，但系统目录始终禁止。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("allow-all", t("全库可访问（默认）"))
          .addOption("allowlist", t("仅白名单目录"))
          .setValue(settings.agentAccessMode)
          .onChange((value) => {
            settings.agentAccessMode = value as "allow-all" | "allowlist";
            save();
          })
      );

    new Setting(containerEl)
      .setName(t("白名单目录"))
      .setDesc(t("逗号分隔，例如 knowledge,projects,agent-logs。"))
      .addText((text) =>
        text
          .setPlaceholder("knowledge,projects")
          .setValue(settings.agentAllowedFolders)
          .onChange((value) => {
            settings.agentAllowedFolders = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName(t("允许读取"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentAllowRead).onChange((value) => {
          settings.agentAllowRead = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("允许新建"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentAllowCreate).onChange((value) => {
          settings.agentAllowCreate = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("允许局部修改"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentAllowPatch).onChange((value) => {
          settings.agentAllowPatch = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("允许全量覆盖"))
      .setDesc(t("默认开启以兼容旧工作流；关闭后 Agent 必须用 patch_note。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentAllowOverwrite).onChange((value) => {
          settings.agentAllowOverwrite = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("允许删除"))
      .setDesc(t("当前插件未开放删除工具，默认关闭。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentAllowDelete).onChange((value) => {
          settings.agentAllowDelete = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("修改前存快照"))
      .setDesc(t("覆盖或 Patch 前保存原文，支持 Agent 变更审查与一键恢复。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.enableAuditSnapshot).onChange((value) => {
          settings.enableAuditSnapshot = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("自动备份统计数据"))
      .setDesc(t("把 data.json 快照写入库内普通文件夹，避免 .obsidian 被同步工具忽略。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.backupEnabled).onChange((value) => {
          settings.backupEnabled = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("备份目录"))
      .setDesc(t("库内相对路径，默认 sediment-backup/。"))
      .addText((text) =>
        text
          .setPlaceholder("sediment-backup")
          .setValue(settings.backupFolder)
          .onChange((value) => {
            settings.backupFolder = value;
            save();
          })
      );

    new Setting(containerEl)
      .setName(t("保留备份份数"))
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(settings.backupKeep))
          .onChange((value) => {
            const count = Number(value);
            settings.backupKeep = Number.isInteger(count) && count > 0 ? count : 10;
            save();
          })
      );

    new Setting(containerEl)
      .setName(t("看板画风"))
      .setDesc(t("像素湖面 / 水墨山水 / 像素城市，也可在看板页脚点「换画风」。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("lake", t("像素湖面"))
          .addOption("ink", t("水墨山水"))
          .addOption("city", t("像素城市"))
          .setValue(settings.artStyle)
          .onChange((value) => {
            settings.artStyle = value as "lake" | "ink" | "city";
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("每日写作目标"))
      .setDesc(t("看板今天卡片显示进度，0 表示关闭。"))
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

    containerEl.createEl("h3", { text: t("统计口径（贡献分封顶与权重）") });
    const recompute = () => {
      this.plugin.store.recomputeContributions();
      this.plugin.refreshViews();
    };
    const numberSetting = (
      name: string,
      desc: string,
      key:
        | "contributionDailyCap"
        | "wordsPerWriteCap"
        | "weightNotesCreated"
        | "weightEdits"
        | "weightTasks"
        | "wordsPerPoint"
        | "focusMinutesPerPoint",
      fallback: number,
      min = 0
    ): void => {
      new Setting(containerEl)
        .setName(t(name))
        .setDesc(t(desc))
        .addText((text) =>
          text
            .setPlaceholder(String(fallback))
            .setValue(String(settings[key]))
            .onChange((value) => {
              const parsed = Number(value);
              settings[key] = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
              save();
              recompute();
            })
        );
    };
    numberSetting("单日贡献分封顶", "防止单日刷分拉爆热力图，0 表示不封顶。默认 120。", "contributionDailyCap", 120);
    numberSetting("单次写入词数上限", "一次保存/粘贴最多计入的词数，0 表示不封顶。默认 4000。", "wordsPerWriteCap", 4000);
    numberSetting("权重：新建笔记（每篇）", "默认 2 分。", "weightNotesCreated", 2);
    numberSetting("权重：编辑会话（每次）", "默认 1 分。", "weightEdits", 1);
    numberSetting("权重：完成任务（每条）", "默认 1 分。", "weightTasks", 1);
    numberSetting("权重：每多少新增词得 1 分", "默认 100 词。", "wordsPerPoint", 100, 1);
    numberSetting("权重：每多少专注分钟得 1 分", "默认 25 分钟。", "focusMinutesPerPoint", 25, 1);
    containerEl.createDiv({
      cls: "sd-setup-hint",
      text: t("修改权重或封顶后会立即全量重算历史贡献分。Agent 写入只计「AI 新增词」，不重复计入人类写作统计。"),
    });

    containerEl.createEl("h3", { text: t("Agent 接入（本地 HTTP / MCP）") });

    new Setting(containerEl)
      .setName(t("启用本地 Agent API"))
      .setDesc(t("只监听 127.0.0.1，供 MCP 桥接和本地脚本调用个人知识库。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.agentServerEnabled).onChange((value) => {
          settings.agentServerEnabled = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("端口"))
      .setDesc(t("默认 27123，修改后服务会自动重启。"))
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
      .setName(t("访问令牌"))
      .setDesc(t("HTTP 请求与 MCP 桥接都必须携带此令牌。"))
      .addText((text) =>
        text
          .setPlaceholder(t("点击右侧按钮生成"))
          .setValue(settings.agentServerToken)
          .onChange((value) => {
            settings.agentServerToken = value.trim();
            save();
          })
      );

    new Setting(containerEl)
      .setName(t("重新生成令牌"))
      .setDesc(t("泄露或遗忘时点击，旧令牌立即失效。"))
      .addButton((button) =>
        button.setButtonText(t("生成新令牌")).onClick(() => {
          settings.agentServerToken = generateToken();
          save();
          this.display();
        })
      );

    containerEl.createEl("h3", { text: t("一键配置智能体客户端") });
    const hint = containerEl.createDiv({ cls: "sd-setup-hint" });
    hint.setText(
      t("自动探测本机已安装的智能体，勾选后一键写入 MCP 配置。写入前会备份原文件，重启客户端即可生效。")
    );
    const agents = detectAgents();
    if (agents.length === 0) {
      containerEl.createDiv({ cls: "kp-empty", text: t("没有探测到受支持的智能体客户端。") });
    }
    for (const agent of agents) {
      const configured = isAgentConfigured(agent);
      new Setting(containerEl)
        .setName(`${agent.name}${configured ? ` · ${t("已配置")}` : ""}`)
        .setDesc(agent.configPath)
        .addButton((button) =>
          button.setButtonText(configured ? t("重新写入") : t("一键配置")).onClick(() => {
            try {
              configureAgent(this.plugin, agent);
              new Notice(tfAgentConfigured(agent.name));
              this.display();
            } catch (error) {
              new Notice(`${t("配置失败")}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })
        );
    }
    new Setting(containerEl)
      .setName(t("复制配置 JSON"))
      .setDesc(t("手动粘贴到客户端的 MCP 配置文件中。"))
      .addButton((button) =>
        button.setButtonText(t("复制")).onClick(() => {
          void navigator.clipboard.writeText(configSnippet(this.plugin)).then(() => new Notice(t("配置已复制")));
        })
      );
  }
}

function tfAgentConfigured(name: string): string {
  return `${name} ${t("配置已写入，重启客户端后生效")}`;
}