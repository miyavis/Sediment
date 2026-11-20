var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/types.ts
var types_exports = {};
__export(types_exports, {
  DEFAULT_DATA: () => DEFAULT_DATA,
  DEFAULT_SETTINGS: () => DEFAULT_SETTINGS,
  METRICS: () => METRICS,
  computeContribution: () => computeContribution,
  createEmptyDay: () => createEmptyDay
});
module.exports = __toCommonJS(types_exports);
var METRICS = [
  { key: "contribution", label: "\u8D21\u732E\u5206", hint: "\u7EFC\u5408\u52A0\u6743\u5F97\u5206" },
  { key: "wordsAdded", label: "\u65B0\u589E\u8BCD\u6570", hint: "\u81EA\u5DF1\u6253\u7684\u5B57" },
  { key: "edits", label: "\u7F16\u8F91\u4F1A\u8BDD", hint: "\u6709\u6548\u7F16\u8F91\u6B21\u6570" },
  { key: "notesCreated", label: "\u65B0\u5EFA\u7B14\u8BB0", hint: "\u5F53\u5929\u6709\u5185\u5BB9\u7684\u65B0\u7B14\u8BB0" },
  { key: "tasksCompleted", label: "\u5B8C\u6210\u4EFB\u52A1", hint: "\u65B0\u589E\u52FE\u9009\u7684\u5F85\u529E" },
  { key: "focusMinutes", label: "\u4E13\u6CE8\u5206\u949F", hint: "\u9884\u7559\u7ED9\u4E13\u6CE8\u63D2\u4EF6\u8054\u52A8" }
];
var DEFAULT_SETTINGS = {
  language: "auto",
  dailyNoteFolder: "daily",
  dailyNoteFormat: "YYYY-MM-DD",
  memoHeading: "## \u901F\u8BB0",
  weekStart: 1,
  heatmapMetric: "contribution",
  trackEdits: true,
  reviewFolder: "reviews",
  workLogFolder: "agent-logs",
  knowledgeFolder: "knowledge",
  knowledgeCategories: "\u6280\u672F,\u9879\u76EE,\u65B9\u6CD5,\u7075\u611F,\u590D\u76D8",
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
  agentWorkMode: "confirm",
  dailyWordGoal: 1e3,
  contributionDailyCap: 120,
  wordsPerWriteCap: 4e3,
  weightNotesCreated: 2,
  weightEdits: 1,
  weightTasks: 1,
  wordsPerPoint: 100,
  focusMinutesPerPoint: 25,
  agentServerEnabled: false,
  agentServerPort: 27123,
  agentServerToken: ""
};
function createEmptyDay() {
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
    aiWordsAdded: 0
  };
}
function computeContribution(d, settings = DEFAULT_SETTINGS) {
  const wordsPer = Math.max(1, settings.wordsPerPoint || 100);
  const focusPer = Math.max(1, settings.focusMinutesPerPoint || 25);
  const raw = d.notesCreated * (settings.weightNotesCreated ?? 2) + d.edits * (settings.weightEdits ?? 1) + d.tasksCompleted * (settings.weightTasks ?? 1) + Math.floor(d.wordsAdded / wordsPer) + Math.floor(d.focusMinutes / focusPer);
  const cap = settings.contributionDailyCap ?? 0;
  return cap > 0 ? Math.min(raw, cap) : raw;
}
var DEFAULT_DATA = {
  version: 1,
  days: {},
  memos: [],
  workLogs: [],
  toolCalls: [],
  snapshots: [],
  editSessions: {},
  focusSessions: [],
  pomodoro: null,
  settings: DEFAULT_SETTINGS
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  METRICS,
  computeContribution,
  createEmptyDay
});
