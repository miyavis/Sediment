import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { configureAgent, configSnippet, allAgentCandidates, detectAgents, isAgentConfigured } from "../agent/setup";
import { uninstallMcp } from "../features/uninstall";
import {
  migrateLegacyFolders,
  planFolderMigrations,
  undoFolderMigration,
  type FolderMigrationOutcome,
} from "../features/folder-migration";
import {
  createDailyNotesAccess,
  syncDailyNotesFolder,
} from "../features/daily-notes-sync";
import { installAgentsGuide, hasAgentsGuide } from "../features/agents-guide";
import { WORK_MODE_LABELS, WORK_MODES, type WorkMode } from "../agent/work-mode";
import { McpUninstallModal } from "./mcp-uninstall-modal";
import { confirmAction } from "./confirm-modal";
import type { SedimentPlugin } from "../main";
import { generateToken } from "../agent/api";
import { METRICS, type MetricKey, type SedimentSettings } from "../types";
import { resolveLocale, setLocale, t, tf } from "../i18n";
import { SETTINGS_SECTIONS } from "./settings-sections";
import { localStamp } from "../utils/dates";

export class SedimentSettingTab extends PluginSettingTab {
  /** 统计权重/封顶输入的防抖定时器：设置页隐藏时统一清理，避免离开后仍触发重算与落盘。 */
  private weightTimers = new Set<number>();

  constructor(app: App, private plugin: SedimentPlugin) {
    super(app, plugin);
  }

  hide(): void {
    for (const id of this.weightTimers) window.clearTimeout(id);
    this.weightTimers.clear();
    super.hide();
  }

  /**
   * 1.13+ 的声明式设置 API 与现有 800 行命令式设置页二选一：返回非空会完全取代 display()，
   * 为了同时兼容 1.8.7+ 与自定义分区/隐藏逻辑，这里保留命令式渲染，声明式清单留空。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  display(): void {
    this.renderSettings();
  }

  /**
   * 实际渲染入口。Obsidian 在 1.13+ 弃用 display()，但声明式设置 API 需要
   * 整体重写 800 行设置页；这里把刷新调用收敛到私有方法，兼容旧版的同时
   * 避免在类内反复触发弃用提示。
   */
  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(t("Sediment 设置")).setHeading();
    const onboarding = containerEl.createDiv({ cls: "sd-onboarding" });
    onboarding.createDiv({ cls: "sd-card-title", text: t("首次使用检查") });
    onboarding.createDiv({
      cls: "sd-card-sub",
      text: t("先确认日记目录、数据位置和备份；Agent 接入是可选的。"),
    });

    const settings = this.plugin.store.settings;
    const save = () => void this.plugin.saveSettings();

    // 详略切换：simple 只显示审计核心；all 显示全部。字段保留，设置不丢。
    const simple = settings.settingsDetail !== "all";
    new Setting(containerEl)
      .setName(t("设置详略"))
      .setDesc(t("简洁模式只显示审计核心设置；其余统计权重、检索增强与实验性选项在「全部」中。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("simple", t("简洁（推荐）"))
          .addOption("all", t("全部设置"))
          .setValue(simple ? "simple" : "all")
          .onChange((value) => {
            settings.settingsDetail = value as "simple" | "all";
            save();
            this.renderSettings();
          })
      );

    // 分区 IA 的单一事实源在 settings-sections.ts；这里按声明顺序渲染标题与内容。
    const SIMPLE_SECTIONS = new Set(["agent", "connection", "clients"]);
    for (const section of SETTINGS_SECTIONS) {
      if (simple && !SIMPLE_SECTIONS.has(section.id)) continue;
      new Setting(containerEl).setName(t(section.title)).setHeading();
      if (section.id === "basics") {
        this.renderBasics(containerEl, settings, save);
        this.renderDisplaySettings(containerEl, settings, save);
      }
      else if (section.id === "agent") this.renderAgent(containerEl, settings, save);
      else if (section.id === "backup") this.renderBackup(containerEl, settings, save);
      else if (section.id === "stats") this.renderStats(containerEl, settings, save);
      else if (section.id === "search") this.renderSearch(containerEl, settings, save);
      else if (section.id === "connection") this.renderConnection(containerEl, settings, save);
      else this.renderClients(containerEl);
    }

    // 简洁模式再隐藏少数高级项：字段与数据保留，只是不占首屏。
    if (simple) {
      const advanced = new Set([t("知识库分类"), t("Agent 禁止访问的标签"), t("Agent 工作日志目录")]);
      for (const el of Array.from(containerEl.querySelectorAll<HTMLElement>(".setting-item"))) {
        const name = el.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
        if (advanced.has(name)) el.addClass("sd-hidden-setting");
      }
    }
  }

  private renderBasics(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
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
            this.renderSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("日记文件夹"))
      .setDesc(t("速记写入的目录，留空表示库根目录。"))
      .addText((text) =>
        text
          .setPlaceholder("Sediment/daily")
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
          .setPlaceholder("Sediment/reviews")
          .setValue(settings.reviewFolder)
          .onChange((value) => {
            settings.reviewFolder = value;
            save();
          })
      );
  }

  /** 迁移、实验性开关与显示相关的基础设置。 */
  private renderDisplaySettings(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    const migrationSetting = new Setting(containerEl)
      .setName(t("旧版目录迁移"))
      .setDesc(
        t("把旧默认目录（daily、reviews、agent-logs、knowledge、sediment-backup）整体移入 Sediment/，避免与库内已有目录撞名。仅迁移仍是旧默认值的目录，自定义路径不受影响。")
      )
      .addButton((button) =>
        button.setButtonText(t("一键迁移")).onClick(() => void this.runLegacyFolderMigration())
      );
    if (this.plugin.store.data.folderMigration) {
      migrationSetting.addButton((button) =>
        button
          .setButtonText(t("撤销迁移"))
          .setCta()
          .onClick(() => void this.undoLegacyFolderMigration())
      );
    }

    new Setting(containerEl).setName(t("实验性功能")).setHeading();
    const experimental: Array<[keyof SedimentSettings, string, string]> = [
      ["showMoonPhase", t("月相日历"), t("年度画像中显示月相页签（装饰性，默认关闭）。")],
      ["showMemoWander", t("速记漫步"), t("按共同词推荐一条旧速记（默认关闭）。")],
      ["showPoster", t("月报海报导出"), t("洞察页脚显示月报 PNG 导出（默认关闭）。")],
      ["multiArtStyle", t("多画风切换"), t("开放像素湖面 / 水墨 / 城市三种画风切换（默认关闭，固定湖面）。")],
    ];
    for (const [key, name, desc] of experimental) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((toggle) =>
          toggle.setValue(Boolean(settings[key])).onChange((value) => {
            (settings[key] as boolean) = value;
            save();
            this.plugin.refreshViews();
          })
        );
    }

    if (settings.multiArtStyle) new Setting(containerEl)
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

    new Setting(containerEl)
      .setName(t("界面密度"))
      .setDesc(t("精简模式优先显示捕获、任务和摘要。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("compact", t("精简"))
          .addOption("standard", t("标准"))
          .addOption("full", t("完整"))
          .setValue(settings.layoutDensity)
          .onChange((value) => {
            settings.layoutDensity = value as "compact" | "standard" | "full";
            save();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("启用专注时长采集"))
      .setDesc(t("在「知识地层」显示专注按钮；完成后计入当日专注分钟与地层专注层。关闭后专注层为 0。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.focusTrackingEnabled).onChange((value) => {
          settings.focusTrackingEnabled = value;
          save();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName(t("减少动态效果"))
      .setDesc(t("关闭横幅和卡片动画，保留必要状态反馈。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.reducedMotion).onChange((value) => {
          settings.reducedMotion = value;
          save();
          this.plugin.refreshViews();
        })
      );
  }

  private renderAgent(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    this.renderWorkModeSection(containerEl, settings, save);
    this.renderPermissionSection(containerEl, settings, save);
    this.renderAgentFoldersSection(containerEl, settings, save);
  }

  private renderWorkModeSection(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    new Setting(containerEl)
      .setName(t("Agent 工作模式"))
      .setDesc(t("选择只读、草稿、确认后写入或自动执行；「确认后写入」档下 Agent 的写操作会挂起为待审项，在看板「待审写入」中采纳后才落盘。实际权限仍受下方开关约束。"))
      .addDropdown((dropdown) => {
        for (const mode of WORK_MODES) dropdown.addOption(mode, t(WORK_MODE_LABELS[mode]));
        dropdown
          .setValue(settings.agentWorkMode)
          .onChange((value) => {
            const next = value as WorkMode;
            if (next === settings.agentWorkMode) return;
            // 切换档位会静默覆写 5 个权限开关，先说清楚再动手；取消则还原下拉。
            void confirmAction(this.app, tf(
              "切换为「{mode}」将重置 5 个权限开关：允许读取、允许新建、允许局部修改、允许全量覆盖、允许删除（删除始终关闭）。是否继续？",
              { mode: t(WORK_MODE_LABELS[next]) }
            )).then((ok) => {
              if (!ok) {
                dropdown.setValue(settings.agentWorkMode);
                return;
              }
              settings.agentWorkMode = next;
              if (settings.agentWorkMode === "readonly") {
                settings.agentAllowRead = true;
                settings.agentAllowCreate = false;
                settings.agentAllowPatch = false;
                settings.agentAllowOverwrite = false;
                settings.agentAllowDelete = false;
              } else if (settings.agentWorkMode === "draft") {
                settings.agentAllowRead = true;
                settings.agentAllowCreate = true;
                settings.agentAllowPatch = false;
                settings.agentAllowOverwrite = false;
                settings.agentAllowDelete = false;
              } else {
                settings.agentAllowRead = true;
                settings.agentAllowCreate = true;
                settings.agentAllowPatch = true;
                settings.agentAllowOverwrite = true;
                settings.agentAllowDelete = false;
              }
              save();
              this.renderSettings();
            });
          });
      });
  }

  private renderPermissionSection(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
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
      .setName(t("修改前存快照"))
      .setDesc(t("覆盖或 Patch 前保存原文，支持 Agent 变更审查与一键恢复。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.enableAuditSnapshot).onChange((value) => {
          settings.enableAuditSnapshot = value;
          save();
        })
      );
  }

  private renderAgentFoldersSection(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    new Setting(containerEl)
      .setName(t("Agent 工作日志目录"))
      .setDesc(t("智能体每次工作的沉淀日志，默认按天写入一个文件。"))
      .addText((text) =>
        text
          .setPlaceholder("Sediment/agent-logs")
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
          .setPlaceholder("Sediment/knowledge")
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
      .setDesc(t("逗号分隔；带这些标签的笔记对 Agent 不可读写。"))
      .addText((text) =>
        text
          .setPlaceholder("例如：私密,密码")
          .setValue(settings.deniedTags)
          .onChange((value) => {
            settings.deniedTags = value;
            save();
          })
      );
  }

  /** 一键把旧默认目录收进 Sediment/：确认 → 逐文件移动（保留链接）→ 同步日记插件 → 记录 → 保存。 */
  private async runLegacyFolderMigration(): Promise<void> {
    const settings = this.plugin.store.settings;
    const plan = planFolderMigrations(settings);
    if (plan.length === 0) {
      new Notice(t("没有需要迁移的旧默认目录。"));
      return;
    }
    const list = plan.map((item) => `  ${item.from} → ${item.to}`).join("\n");
    const confirmed = await confirmAction(
      this.app,
      tf(
        "将迁移以下旧默认目录到 Sediment/：\n{list}\n\n文件会逐个移动（Obsidian 内的链接自动更新）；目标已有同名文件的目录会整体跳过。若 Obsidian 核心「日记」插件指向旧目录，将自动同步到新目录；无法自动同步时会提示手动修改。确定继续？",
        { list }
      )
    );
    if (!confirmed) return;

    let outcome: FolderMigrationOutcome;
    try {
      outcome = await migrateLegacyFolders({
        settings,
        vault: this.app.vault,
        fileManager: this.app.fileManager,
      });
    } catch (error) {
      new Notice(
        tf("目录迁移失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
        10_000
      );
      return;
    }

    const parts: string[] = [];
    if (outcome.migrated.length > 0) {
      this.plugin.store.logDiagnostic(
        "storage",
        tf("目录迁移完成：{n} 个目录、{files} 个文件", { n: outcome.migrated.length, files: outcome.movedFiles })
      );
      parts.push(tf("已迁移 {n} 个目录、{files} 个文件", { n: outcome.migrated.length, files: outcome.movedFiles }));

      // 若 daily 目录确实迁移了，尝试自动同步核心日记插件路径。
      let dailyNotesBefore: string | undefined;
      const dailyItem = outcome.migrated.find((item) => item.key === "dailyNoteFolder");
      if (dailyItem) {
        const access = createDailyNotesAccess(this.app);
        // 仅在插件当前仍指向旧目录时才会改写，记录改写前的旧值用于撤销。
        const current = access?.get() ?? null;
        const sync = syncDailyNotesFolder(access, dailyItem.from, dailyItem.to);
        if (sync === "changed") {
          dailyNotesBefore = current ?? dailyItem.from;
          parts.push(t("已自动同步核心「日记」插件目录"));
        } else if (sync === "unavailable") {
          parts.push(t("无法自动同步核心「日记」插件目录，请手动修改其设置"));
        }
      }

      this.plugin.store.data.folderMigration = {
        at: new Date().toISOString(),
        items: outcome.migrated.map((item) => ({ key: item.key, from: item.from, to: item.to })),
        ...(dailyNotesBefore !== undefined ? { dailyNotesFolderBefore: dailyNotesBefore } : {}),
      };
      await this.plugin.saveSettings();
      this.plugin.semantic.invalidate();
      this.plugin.refreshViews();
    }
    for (const item of outcome.skipped) {
      parts.push(tf("已跳过 {from}（{reason}）", { from: item.from, reason: item.reason }));
    }
    for (const item of outcome.failed) {
      parts.push(tf("失败 {from}（{reason}）", { from: item.from, reason: item.reason }));
    }
    new Notice(parts.join("；"), outcome.failed.length > 0 ? 15_000 : 6_000);
    if (outcome.migrated.length > 0) this.renderSettings();
  }

  /** 撤销上一次目录迁移：确认 → 反向搬回 → 还原日记插件 → 清记录。 */
  private async undoLegacyFolderMigration(): Promise<void> {
    const record = this.plugin.store.data.folderMigration;
    if (!record) {
      new Notice(t("没有可撤销的目录迁移。"));
      return;
    }
    const confirmed = await confirmAction(
      this.app,
      t("撤销迁移会把目录从 Sediment/ 搬回旧位置并还原设置，确定继续？")
    );
    if (!confirmed) return;

    let outcome: FolderMigrationOutcome;
    try {
      outcome = await undoFolderMigration(
        {
          settings: this.plugin.store.settings,
          vault: this.app.vault,
          fileManager: this.app.fileManager,
        },
        record
      );
    } catch (error) {
      new Notice(
        tf("撤销迁移失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
        10_000
      );
      return;
    }

    const parts: string[] = [];
    if (outcome.migrated.length > 0) {
      parts.push(tf("已撤销 {n} 个目录、{files} 个文件", { n: outcome.migrated.length, files: outcome.movedFiles }));
      // 还原日记插件：仅当它仍指向我们改写后的新目录时回退。
      if (record.dailyNotesFolderBefore !== undefined) {
        const dailyItem = record.items.find((item) => item.key === "dailyNoteFolder");
        if (dailyItem) {
          const access = createDailyNotesAccess(this.app);
          const sync = syncDailyNotesFolder(access, dailyItem.to, record.dailyNotesFolderBefore);
          if (sync === "changed") parts.push(t("已还原核心「日记」插件目录"));
          else if (sync === "unavailable") parts.push(t("核心「日记」插件目录需手动还原"));
        }
      }
    }
    for (const item of outcome.skipped) {
      parts.push(tf("已跳过 {from}（{reason}）", { from: item.from, reason: item.reason }));
    }
    for (const item of outcome.failed) {
      parts.push(tf("失败 {from}（{reason}）", { from: item.from, reason: item.reason }));
    }

    // 全部撤销成功（无失败、无跳过）才清空记录；部分失败时保留以便重试。
    if (outcome.failed.length === 0 && outcome.skipped.length === 0) {
      this.plugin.store.data.folderMigration = null;
    }
    await this.plugin.saveSettings();
    this.plugin.semantic.invalidate();
    this.plugin.refreshViews();
    new Notice(parts.join("；") || t("没有需要撤销的目录。"), outcome.failed.length > 0 ? 15_000 : 6_000);
    this.renderSettings();
  }

  private renderBackup(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    new Setting(containerEl)
      .setName(t("自动备份统计数据"))
      .setDesc(t("把 data.json 快照写入库内普通文件夹，避免配置文件夹被同步工具忽略。"))
      .addToggle((toggle) =>
        toggle.setValue(settings.backupEnabled).onChange((value) => {
          settings.backupEnabled = value;
          save();
        })
      );

    new Setting(containerEl)
      .setName(t("备份目录"))
      .setDesc(t("库内相对路径，默认 Sediment/backups/。"))
      .addText((text) =>
        text
          .setPlaceholder("Sediment/backups")
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
            const valid = Number.isInteger(count) && count > 0;
            settings.backupKeep = valid ? count : 10;
            // 静默回退会让用户误以为输入已生效：非法输入明确提示。
            if (!valid) new Notice(t("保留份数需为正整数，已回退为 10"));
            save();
          })
      );
    this.renderRecoveryList(containerEl);
  }

  /** 数据快照恢复列表：自智能体工坊挪入备份分区（低频维护操作不占审核页）。
   *  恢复是重操作：先二次确认；恢复副本写入失败（recovery="failed"）必须显著告警，
   *  全新安装无当前数据（recovery="none"）则正常提示，不误报失败。 */
  private renderRecoveryList(containerEl: HTMLElement): void {
    containerEl.createDiv({ cls: "sd-card-title", text: t("数据快照恢复") });
    containerEl.createDiv({
      cls: "sd-card-sub",
      text: t("列出备份目录中的 data.json 快照，可一键恢复统计数据。恢复前会先把当前数据另存为恢复副本，恢复错了也能回退。"),
    });
    containerEl.createDiv({
      cls: "sd-card-sub",
      text: t("备份目录为库根目录时，列表可能混入你自己创建的 data-*.json；恢复前会校验内容格式，损坏或非本插件数据会被拒绝。"),
    });
    if (this.plugin.store.isPersistenceBlocked) {
      containerEl.createDiv({
        cls: "sd-card-sub sd-recovery-warning",
        text: t("数据写入已暂停以保护原始数据；恢复一份有效快照可解除暂停。"),
      });
    }
    const backups = this.plugin.store.listDataBackups();
    if (backups.length === 0) {
      containerEl.createDiv({ cls: "sd-empty", text: t("还没有数据备份。开启「自动备份统计数据」后，快照会出现在这里。") });
      return;
    }
    const list = containerEl.createDiv({ cls: "sd-feed-list" });
    for (const backup of backups.slice(0, 20)) {
      const row = list.createDiv({ cls: "sd-feed-row sd-feed-row-audit" });
      row.createSpan({
        text: `${backup.name} · ${localStamp(new Date(backup.savedAt).toISOString())} · ${(backup.size / 1024).toFixed(1)} KB`,
        attr: { title: backup.name },
      });
      const actions = row.createDiv({ cls: "sd-audit-actions" });
      actions.createEl("button", { text: t("恢复") }).onclick = () => {
        void confirmAction(
          this.app,
          t("确认从该快照恢复统计数据？当前数据会先另存为恢复副本，恢复后看板立即重载。")
        ).then((ok) => {
          if (!ok) return;
          void this.plugin.store.restoreDataBackup(backup.name).then((result) => {
            if (result.recovery === "failed") {
              // 恢复副本创建失败：备份已写回但失去回退保险，必须显著告警。
              new Notice(t("恢复副本创建失败：备份已恢复，但当前数据未能另存副本。请立即手动备份 data.json，避免再次恢复时无法回退。"), 15_000);
            } else if (result.recovery === "none") {
              // 全新安装没有当前数据可备份：无需恢复副本，不是失败。
              new Notice(tf("已从 {name} 恢复（此前无数据，无需恢复副本）", { name: backup.name }));
            } else {
              new Notice(tf("已从 {name} 恢复，恢复副本：{path}", { name: backup.name, path: result.recoveryPath }));
            }
            this.plugin.refreshViews();
            this.renderSettings();
          }).catch((error) => {
            new Notice(error instanceof Error ? error.message : String(error));
          });
        });
      };
    }
  }

  private renderStats(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
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
      min = 0,
      target: HTMLElement = containerEl
    ): void => {
      // 每键击都全量重算历史贡献分太重：300ms 防抖，停手后才落盘重算。
      let debounceTimer: number | null = null;
      new Setting(target)
        .setName(t(name))
        .setDesc(t(desc))
        .addText((text) =>
          text
            .setPlaceholder(String(fallback))
            .setValue(String(settings[key]))
            .onChange((value) => {
              if (debounceTimer !== null) {
                window.clearTimeout(debounceTimer);
                this.weightTimers.delete(debounceTimer);
              }
              const id = window.setTimeout(() => {
                this.weightTimers.delete(id);
                debounceTimer = null;
                const parsed = Number(value);
                settings[key] = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
                save();
                recompute();
              }, 300);
              debounceTimer = id;
              this.weightTimers.add(id);
            })
        );
    };
    numberSetting("单日贡献分封顶", "防止单日刷分拉爆热力图，0 表示不封顶。默认 120。达到封顶后，当天后续努力在热力图与地层中不再体现，请按需调高或关闭。", "contributionDailyCap", 120);
    numberSetting("单次写入词数上限", "一次保存/粘贴最多计入的词数，0 表示不封顶。默认 4000。", "wordsPerWriteCap", 4000);
    const weights = containerEl.createEl("details", { cls: "sd-settings-weights" });
    weights.createEl("summary", { text: t("高级权重（默认值已调好，一般无需修改）") });
    numberSetting("权重：新建笔记（每篇）", "默认 2 分。", "weightNotesCreated", 2, 0, weights);
    numberSetting("权重：编辑会话（每次）", "默认 1 分。", "weightEdits", 1, 0, weights);
    numberSetting("权重：完成任务（每条）", "默认 1 分。", "weightTasks", 1, 0, weights);
    numberSetting("权重：每多少新增词得 1 分", "默认 100 词。", "wordsPerPoint", 100, 1, weights);
    numberSetting("权重：每多少专注分钟得 1 分", "默认 25 分钟。", "focusMinutesPerPoint", 25, 1, weights);
    containerEl.createDiv({
      cls: "sd-setup-hint",
      text: t("修改权重或封顶后会立即全量重算历史贡献分。Agent 写入只计「AI 新增词」，不重复计入人类写作统计。"),
    });
  }

  private renderSearch(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
    const invalidate = () => this.plugin.semantic.invalidate();
    new Setting(containerEl)
      .setName(t("语义检索引擎"))
      .setDesc(t("默认 TF-IDF 纯本地。选 Embedding 需本机运行 Ollama，不可用时自动回退 TF-IDF。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tfidf", t("TF-IDF（纯本地）"))
          .addOption("embedding", t("Embedding（Ollama）"))
          .setValue(settings.semanticEngine)
          .onChange((value) => {
            settings.semanticEngine = value as "tfidf" | "embedding";
            save();
            invalidate();
          })
      );
    new Setting(containerEl)
      .setName(t("Ollama 地址"))
      .setDesc(t("默认 http://127.0.0.1:11434，仅本机回环。"))
      .addText((text) =>
        text.setPlaceholder("http://127.0.0.1:11434").setValue(settings.embeddingEndpoint).onChange((value) => {
          settings.embeddingEndpoint = value.trim() || "http://127.0.0.1:11434";
          save();
          invalidate();
        })
      );
    new Setting(containerEl)
      .setName(t("Embedding 模型"))
      .setDesc(t("需先 ollama pull，例如 bge-m3。更换模型会重建向量。"))
      .addText((text) =>
        text.setPlaceholder("bge-m3").setValue(settings.embeddingModel).onChange((value) => {
          settings.embeddingModel = value.trim() || "bge-m3";
          save();
          invalidate();
        })
      );
    containerEl.createDiv({
      cls: "sd-setup-hint",
      text: t("Embedding 只发文本到本机 Ollama，不访问外网；关闭即回到零依赖 TF-IDF。"),
    });
  }

  private renderConnection(containerEl: HTMLElement, settings: SedimentSettings, save: () => void): void {
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

    let tokenRevealed = false;
    const tokenSetting = new Setting(containerEl)
      .setName(t("访问令牌"))
      .setDesc(t("HTTP 请求与 MCP 桥接都必须携带此令牌。"));
    tokenSetting.addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder(t("点击右侧按钮生成"))
        .setValue(settings.agentServerToken)
        .onChange((value) => {
          settings.agentServerToken = value.trim();
          save();
        });
      tokenSetting.addButton((button) =>
        button
          .setButtonText(t("显示"))
          .onClick(() => {
            tokenRevealed = !tokenRevealed;
            text.inputEl.type = tokenRevealed ? "text" : "password";
            button.setButtonText(tokenRevealed ? t("隐藏") : t("显示"));
          })
      );
    });

    new Setting(containerEl)
      .setName(t("重新生成令牌"))
      .setDesc(t("泄露或遗忘时点击，旧令牌立即失效。"))
      .addButton((button) =>
        button.setButtonText(t("生成新令牌")).onClick(() => {
          settings.agentServerToken = generateToken();
          save();
          this.renderSettings();
        })
      );

    const agentsGuideSetting = new Setting(containerEl)
      .setName(t("安装 AGENTS.md 规则"))
      .setDesc(t("在库根写入 AGENTS.md，告诉编码智能体一律走 MCP 写入。"));
    agentsGuideSetting.addButton((button) =>
      button.setButtonText(t("一键安装")).setDisabled(hasAgentsGuide(this.app.vault)).onClick(async () => {
        const result = await installAgentsGuide(this.app.vault);
        new Notice(result === "created" ? t("已在库根创建 AGENTS.md") : t("库根已有 AGENTS.md，未覆盖"));
        this.renderSettings();
      })
    );
    if (hasAgentsGuide(this.app.vault)) {
      agentsGuideSetting.addButton((button) =>
        button.setButtonText(t("更新规则")).setCta().onClick(async () => {
          const result = await installAgentsGuide(this.app.vault, true);
          new Notice(result === "updated" ? t("AGENTS.md 已更新，原文件已备份为 .bak") : t("AGENTS.md 更新失败"));
        })
      );
    }

    new Setting(containerEl)
      .setName(t("启用文件桥（实验）"))
      .setDesc(
        t(
          "非 MCP 智能体可把 write_note / patch_note / add_knowledge 提案放进插件目录 bridge/proposals/，在工坊预览后采纳或驳回；结果写到 bridge/decisions/。默认关闭，提案不会自动落盘。"
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.fileBridgeEnabled).onChange((value) => {
          settings.fileBridgeEnabled = value;
          save();
        })
      );
  }

  private renderClients(containerEl: HTMLElement): void {
    const hint = containerEl.createDiv({ cls: "sd-setup-hint" });
    hint.setText(
      t("自动探测本机已安装的智能体，勾选后一键写入 MCP 配置。写入前会备份原文件，重启客户端即可生效。")
    );
    const detected = new Set(detectAgents().map((a) => a.id));
    const all = allAgentCandidates();
    const renderAgentRow = (host: HTMLElement, agent: typeof all[number]): void => {
      const configured = isAgentConfigured(agent);
      new Setting(host)
        .setName(`${agent.name}${configured ? ` · ${t("已配置")}` : ""}`)
        .setDesc(agent.configPath)
        .addButton((button) =>
          button.setButtonText(configured ? t("重新写入") : t("一键配置")).onClick(() => {
            try {
              configureAgent(this.plugin, agent);
              new Notice(tfAgentConfigured(agent.name));
              // 一键配置后若本地 API 未启用，自动打开并保存——避免 MCP 客户端连不上（C3）。
              if (!this.plugin.store.settings.agentServerEnabled) {
                this.plugin.store.settings.agentServerEnabled = true;
                void this.plugin.saveSettings();
                new Notice(t("已自动启用本地 API，MCP 客户端现在可以连接"));
              }
              this.renderSettings();
            } catch (error) {
              new Notice(`${t("配置失败")}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })
        )
        .addButton((button) => {
          button.setButtonText(t("卸载"));
          button.setDisabled(!configured);
          button.onClick(() => {
            const result = uninstallMcp(this.plugin, [agent.id], false);
            new Notice(
              result.failures.length > 0
                ? `${t("卸载失败")}: ${result.failures.join("；")}`
                : `${agent.name} ${t("MCP 配置已移除，重启客户端后生效")}`
            );
            this.renderSettings();
          });
        });
    };

    // 已检测到的客户端优先展示
    for (const agent of all.filter((a) => detected.has(a.id))) renderAgentRow(containerEl, agent);

    // 未检测到的默认折叠：始终展示支持范围，避免用户以为只支持已有的那几个
    const undetected = all.filter((a) => !detected.has(a.id));
    if (undetected.length > 0) {
      const details = containerEl.createEl("details", { cls: "sd-agents-undetected" });
      details.createEl("summary", {
        text: tf("未检测到 {n} 个受支持的客户端（点击展开）", { n: undetected.length }),
      });
      for (const agent of undetected) {
        const row = details.createDiv({ cls: "sd-agent-undetected" });
        row.createSpan({ text: `${agent.name} · ${t("未检测到配置文件")}` });
        row.createSpan({ cls: "sd-agent-undetected-hint", text: agent.configPath });
      }
    }
    new Setting(containerEl)
      .setName(t("一键卸载 MCP 接入"))
      .setDesc(t("选择要移除的客户端配置和桥接脚本；不会删除笔记或统计数据。"))
      .addButton((button) =>
        button.setButtonText(t("打开卸载向导")).onClick(() => new McpUninstallModal(this.plugin).open())
      );

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