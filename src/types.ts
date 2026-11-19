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
  /** 由 Agent API 写入的新增词数（用于人机双色热力图） */
  aiWordsAdded: number;
}

/** 一次 MCP/HTTP 工具调用的审计记录 */
export interface ToolCallRecord {
  time: string;
  tool: string;
  agent: string;
  path: string;
}

export interface MemoRecord {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  text: string;
  tags: string[];
  converted: boolean;
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
  /** 看板画风：像素湖面 / 水墨山水 / 像素城市 */
  artStyle: "lake" | "ink" | "city";
  /** 每天写作目标字数，0 表示关闭 */
  dailyWordGoal: number;
  /** 是否开启 127.0.0.1 上的 Agent HTTP API */
  agentServerEnabled: boolean;
  /** Agent HTTP API 端口 */
  agentServerPort: number;
  /** Agent HTTP API / MCP 访问令牌 */
  agentServerToken: string;
}

export interface PulseData {
  version: number;
  days: Record<string, DayRecord>;
  memos: MemoRecord[];
  workLogs: WorkLogRecord[];
  toolCalls: ToolCallRecord[];
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
  artStyle: "lake",
  dailyWordGoal: 1000,
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
 * 透明公开的贡献公式：
 * 新建笔记×2 + 编辑会话 + 完成任务 + 新增词数/100 + 专注分钟/25
 * 分项之和严格等于总分。
 */
export function computeContribution(d: DayRecord): number {
  return (
    d.notesCreated * 2 +
    d.edits +
    d.tasksCompleted +
    Math.floor(d.wordsAdded / 100) +
    Math.floor(d.focusMinutes / 25)
  );
}

export const DEFAULT_DATA: PulseData = {
  version: 1,
  days: {},
  memos: [],
  workLogs: [],
  toolCalls: [],
  settings: DEFAULT_SETTINGS,
};
