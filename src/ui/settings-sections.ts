/** 设置面板分区数据（IA 单一事实源）：标题与归属键在此声明，settings-tab 按此渲染分区标题。
 *  纯数据模块，供单测断言分区顺序与归属，防止 37 项设置再次平铺回灌。 */

export interface SettingsSection {
  id: string;
  /** 中文源串，渲染时走 t()。 */
  title: string;
  /** 归属本区的设置键（PulseSettings 字段名）；clients 区为按钮组，无设置键。 */
  keys: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "basics",
    title: "基础",
    keys: [
      "language",
      "dailyNoteFolder",
      "dailyNoteFormat",
      "memoHeading",
      "weekStart",
      "heatmapMetric",
      "trackEdits",
      "reviewFolder",
      "artStyle",
      "dailyWordGoal",
      "layoutDensity",
      "reducedMotion",
    ],
  },
  {
    id: "agent",
    title: "Agent 权限（可选）",
    keys: [
      "agentWorkMode",
      "agentAccessMode",
      "agentAllowedFolders",
      "agentAllowRead",
      "agentAllowCreate",
      "agentAllowPatch",
      "agentAllowOverwrite",
      "enableAuditSnapshot",
      "workLogFolder",
      "knowledgeFolder",
      "knowledgeCategories",
      "deniedFolders",
      "deniedTags",
    ],
  },
  {
    id: "backup",
    title: "数据备份",
    keys: ["backupEnabled", "backupFolder", "backupKeep"],
  },
  {
    id: "stats",
    title: "统计口径（贡献分封顶与权重）",
    keys: [
      "contributionDailyCap",
      "wordsPerWriteCap",
      "weightNotesCreated",
      "weightEdits",
      "weightTasks",
      "wordsPerPoint",
      "focusMinutesPerPoint",
    ],
  },
  {
    id: "search",
    title: "检索增强（可选）",
    keys: ["semanticEngine", "embeddingEndpoint", "embeddingModel"],
  },
  {
    id: "connection",
    title: "Agent 接入（本地 HTTP / MCP）",
    keys: ["agentServerEnabled", "agentServerPort", "agentServerToken"],
  },
  {
    id: "clients",
    title: "一键配置智能体客户端",
    keys: [],
  },
];

export function settingsSection(id: string): SettingsSection {
  const section = SETTINGS_SECTIONS.find((item) => item.id === id);
  if (!section) throw new Error(`未知设置分区：${id}`);
  return section;
}
