/** 数据模型与默认配置。 */

export type MetricKey =
  | "contribution"
  | "wordsAdded"
  | "edits"
  | "notesCreated"
  | "tasksCompleted"
  | "focusMinutes";

export interface DayRecord {
  /** 自己输入的词数（中文按字计，英文按词计） */
  wordsAdded: number;
  /** 删除的词数 */
  wordsRemoved: number;
  /** 有效编辑会话数 */
  edits: number;
  /** 新建且有内容笔记数 */
  notesCreated: number;
  /** 新增勾选的待办数 */
  tasksCompleted: number;
  /** 专注分钟（预留给专注插件联动） */
  focusMinutes: number;
  /** 由上面各项加权算出的综合得分 */
  contribution: number;
  /** 按小时统计的新增词数（0-23） */
  hourlyWords: number[];
  /** 大段捕获（粘贴）词数 */
  capturedWords: number;
  /** 按目录统计的新增词数 */
  folderWords: Record<string, number>;
  /** 交互活跃分钟（按 5 分钟桶估算） */
  activeMinutes: number;
  /** 由 Agent API 写入的新增词数（地层剖面的 AI 沉积层） */
  aiWordsAdded: number;
}

/** 一次 MCP/HTTP 工具调用的审计记录 */
export interface ToolCallRecord {
  time: string;
  tool: string;
  agent: string;
  path: string;
}

/** 真实环境诊断记录 */
export interface DiagnosticRecord {
  time: string;
  category: "migration" | "security" | "performance" | "storage";
  message: string;
  detail?: string;
}

/** 修改前的全文快照记录 */
export interface SnapshotRecord {
  id: string;
  path: string;
  time: string;
  tool: string;
  agent: string;
}

/**
 * confirm 工作模式下被挂起、等待人工审查的 Agent 写入。
 * request 保存原请求，采纳时按原路径重放真正的落盘函数；
 * before/after 仅用于 DiffModal 预览（条目式写入的 after 为摘要文本）。
 */
export interface PendingWriteRecord {
  id: string;
  /** 挂起时刻（ISO） */
  time: string;
  /** 逻辑工具名，如 write_note / patch_note / add_knowledge */
  tool: string;
  agent: string;
  /** 目标文件路径（库内相对路径） */
  path: string;
  /** 采纳重放所需的原请求 */
  request: { kind: string; args: Record<string, unknown> };
  /** 预览：挂起时的目标内容（新建或条目式写入为空串） */
  before: string;
  /** 预览：采纳后的内容或操作摘要 */
  after: string;
}

export interface MemoRecord {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  text: string;
  tags: string[];
  converted: boolean;
  /** 归档后不在默认列表与积压统计中出现，日记 Callout 保留作为历史 */
  archived?: boolean;
  /** 任务完成时关联的产出笔记路径 */
  resultPath?: string;
  /** 由原生待办转来时，记录原始复选框所在的笔记与行号 */
  sourcePath?: string;
  sourceLine?: number;
}

/** Agent 一次工作会话的沉淀记录。 */
export interface WorkLogRecord {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  agent: string; // opencode / qoder / ...
  task: string;
  summary: string;
  decisions: string;
  files: string[];
  learnings: string;
  openQuestions: string;
  tags: string[];
}

export interface PulseSettings {
  /** 界面语言：auto 跟随 Obsidian，zh / en 强制 */
  language: "auto" | "zh" | "en";
  /** 速记写入的目录，留空表示库根目录 */
  dailyNoteFolder: string;
  /** 日记文件名格式，支持 YYYY / MM / DD */
  dailyNoteFormat: string;
  /** 速记段落标题 */
  memoHeading: string;
  /** 0 = 周日，1 = 周一 */
  weekStart: 0 | 1;
  /** 热力图默认指标 */
  heatmapMetric: MetricKey;
  /** 是否统计有效编辑会话 */
  trackEdits: boolean;
  /** 周复盘归档目录 */
  reviewFolder: string;
  /** Agent 工作日志目录 */
  workLogFolder: string;
  /** Agent 沉淀的知识笔记目录 */
  knowledgeFolder: string;
  /** 知识库分类（逗号分隔），沉淀时按分类建子目录 */
  knowledgeCategories: string;
  /** 上次提示过的版本号，用于升级时展示增量更新记录 */
  lastSeenVersion: string;
  /** Agent 禁止访问的文件夹（逗号分隔） */
  deniedFolders: string;
  /** Agent 禁止访问的标签（逗号分隔） */
  deniedTags: string;
  /** 访问模式：全库 / 仅白名单目录 */
  agentAccessMode: "allow-all" | "allowlist";
  /** 白名单目录（逗号分隔，allowlist 模式生效） */
  agentAllowedFolders: string;
  /** 允许的操作 */
  agentAllowRead: boolean;
  agentAllowCreate: boolean;
  agentAllowPatch: boolean;
  agentAllowOverwrite: boolean;
  agentAllowDelete: boolean;
  /** 修改前是否自动存快照 */
  enableAuditSnapshot: boolean;
  /** 是否定期把 data.json 备份到库内普通文件夹 */
  backupEnabled: boolean;
  /** 备份目录（库内相对路径） */
  backupFolder: string;
  /** 保留的备份份数 */
  backupKeep: number;
  /** 看板画风：像素湖面 / 水墨山水 / 像素城市 */
  artStyle: "lake" | "ink" | "city";
  /** 界面密度 */
  layoutDensity: "compact" | "standard" | "full";
  /** 减少装饰动画和状态过渡 */
  reducedMotion: boolean;
  /** 是否已关闭首次使用上下文提示 */
  hintsDismissed: boolean;
  /** 是否记录诊断日志 */
  diagnosticsEnabled: boolean;
  /** Agent 权限工作模式 */
  agentWorkMode: "readonly" | "draft" | "confirm" | "auto";
  /** 每天写作目标字数，0 表示关闭 */
  dailyWordGoal: number;
  /** 单日贡献分封顶，0 表示不封顶 */
  contributionDailyCap: number;
  /** 单次写入计入统计的词数上限（防大段粘贴刷分），0 表示不封顶 */
  wordsPerWriteCap: number;
  /** 贡献公式权重：新建笔记每篇得分 */
  weightNotesCreated: number;
  /** 贡献公式权重：编辑会话每次得分 */
  weightEdits: number;
  /** 贡献公式权重：完成任务每条得分 */
  weightTasks: number;
  /** 贡献公式权重：每多少新增词得 1 分 */
  wordsPerPoint: number;
  /** 贡献公式权重：每多少专注分钟得 1 分 */
  focusMinutesPerPoint: number;
  /** 是否开启 127.0.0.1 上的 Agent HTTP API */
  agentServerEnabled: boolean;
  /** Agent HTTP API 端口 */
  agentServerPort: number;
  /** Agent HTTP API / MCP 访问令牌 */
  agentServerToken: string;
}

/** 一次专注会话记录（番茄钟完成时写入，实测口径）。 */
export interface FocusSessionRecord {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm 完成时刻
  mode: "focus" | "short" | "long";
  minutes: number;
  /** measured = 番茄钟实测；estimated = 估算 */
  source: "measured" | "estimated";
}

/** 番茄钟持久化状态：运行中按 startedAt/startRemaining 时间戳推算剩余时间。 */
export interface PersistedPomodoro {
  mode: "focus" | "short" | "long";
  remaining: number;
  running: boolean;
  completed: number;
  savedAt: number;
  /** 本段运行的起点（epoch ms）；暂停时为 null。旧数据可能缺失，回退 savedAt。 */
  startedAt?: number | null;
  /** 本段运行开始时的剩余秒数，配合 startedAt 做无漂移换算。 */
  startRemaining?: number;
  /** 写入方实例标识，用于多开 Obsidian 时的单实例检测。 */
  instanceId?: string;
  /** 最近一次心跳时间（epoch ms），心跳新鲜视为另一实例存活。 */
  heartbeatAt?: number;
}

export interface PulseData {
  version: number;
  days: Record<string, DayRecord>;
  memos: MemoRecord[];
  workLogs: WorkLogRecord[];
  toolCalls: ToolCallRecord[];
  snapshots: SnapshotRecord[];
  /** 已审查的 Agent 变更：key -> kept | reverted */
  reviewedChanges: Record<string, "kept" | "reverted">;
  /** confirm 模式下挂起待审的 Agent 写入，采纳/驳回后移除；重启后保留 */
  pendingWrites: PendingWriteRecord[];
  diagnostics: DiagnosticRecord[];
  /** 已计过编辑会话的 日期→文件路径 列表，重启后不重复计分 */
  editSessions: Record<string, string[]>;
  /** 专注会话日志（实测），最多保留 500 条 */
  focusSessions: FocusSessionRecord[];
  /** 番茄钟状态，退出/重启不丢 */
  pomodoro: PersistedPomodoro | null;
  settings: PulseSettings;
}

export interface MetricDef {
  key: MetricKey;
  label: string;
  hint: string;
}

export const METRICS: MetricDef[] = [
  { key: "contribution", label: "贡献分", hint: "综合加权得分" },
  { key: "wordsAdded", label: "新增词数", hint: "自己打的字" },
  { key: "edits", label: "编辑会话", hint: "有效编辑次数" },
  { key: "notesCreated", label: "新建笔记", hint: "当天有内容的新笔记" },
  { key: "tasksCompleted", label: "完成任务", hint: "新增勾选的待办" },
  { key: "focusMinutes", label: "专注分钟", hint: "预留给专注插件联动" },
];

export const DEFAULT_SETTINGS: PulseSettings = {
  language: "auto",
  dailyNoteFolder: "daily",
  dailyNoteFormat: "YYYY-MM-DD",
  memoHeading: "## 速记",
  weekStart: 1,
  heatmapMetric: "contribution",
  trackEdits: true,
  reviewFolder: "reviews",
  workLogFolder: "agent-logs",
  knowledgeFolder: "knowledge",
  knowledgeCategories: "技术,项目,方法,灵感,复盘",
  lastSeenVersion: "",
  deniedFolders: "",
  deniedTags: "",
  agentAccessMode: "allow-all",
  agentAllowedFolders: "",
  agentAllowRead: true,
  agentAllowCreate: true,
  agentAllowPatch: true,
  agentAllowOverwrite: true,
  agentAllowDelete: false,
  enableAuditSnapshot: true,
  backupEnabled: true,
  backupFolder: "sediment-backup",
  backupKeep: 10,
  artStyle: "lake",
  layoutDensity: "standard",
  reducedMotion: false,
  hintsDismissed: false,
  diagnosticsEnabled: true,
  agentWorkMode: "confirm",
  dailyWordGoal: 1000,
  contributionDailyCap: 120,
  wordsPerWriteCap: 4000,
  weightNotesCreated: 2,
  weightEdits: 1,
  weightTasks: 1,
  wordsPerPoint: 100,
  focusMinutesPerPoint: 25,
  agentServerEnabled: false,
  agentServerPort: 27123,
  agentServerToken: "",
};

export function createEmptyDay(): DayRecord {
  return {
    wordsAdded: 0,
    wordsRemoved: 0,
    edits: 0,
    notesCreated: 0,
    tasksCompleted: 0,
    focusMinutes: 0,
    contribution: 0,
    hourlyWords: Array.from({ length: 24 }, () => 0),
    capturedWords: 0,
    folderWords: {},
    activeMinutes: 0,
    aiWordsAdded: 0,
  };
}

/**
 * 透明公开的贡献公式（权重与封顶可在设置中调整）：
 * 新建笔记×wN + 编辑会话×wE + 完成任务×wT + floor(新增词数/每分词数) + floor(专注分钟/每分时长)，
 * 再按单日封顶截断。默认权重下分项之和严格等于总分。
 */
export function computeContribution(d: DayRecord, settings: PulseSettings = DEFAULT_SETTINGS): number {
  const wordsPer = Math.max(1, settings.wordsPerPoint || 100);
  const focusPer = Math.max(1, settings.focusMinutesPerPoint || 25);
  const raw =
    d.notesCreated * (settings.weightNotesCreated ?? 2) +
    d.edits * (settings.weightEdits ?? 1) +
    d.tasksCompleted * (settings.weightTasks ?? 1) +
    Math.floor(d.wordsAdded / wordsPer) +
    Math.floor(d.focusMinutes / focusPer);
  const cap = settings.contributionDailyCap ?? 0;
  return cap > 0 ? Math.min(raw, cap) : raw;
}

export const DEFAULT_DATA: PulseData = {
  version: 1,
  days: {},
  memos: [],
  workLogs: [],
  toolCalls: [],
  snapshots: [],
  reviewedChanges: {},
  pendingWrites: [],
  diagnostics: [],
  editSessions: {},
  focusSessions: [],
  pomodoro: null,
  settings: DEFAULT_SETTINGS,
};
