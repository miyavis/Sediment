import type { Store } from "../data/store";
import { buildChangeTimeline } from "./change-timeline";
import { contentHash } from "../utils/hash";
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";
import type { Vault } from "obsidian";

export interface ExportOptions {
  /** true = 审计包（变更时间线），false = 每日指标/数据快照 */
  audit?: boolean;
  format: "csv" | "json";
  /** 是否包含速记正文（默认关，脱敏） */
  includeMemoText: boolean;
  /** 是否包含文件路径类字段（默认关，脱敏） */
  includePaths: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: "json",
  includeMemoText: false,
  includePaths: false,
};

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 每日指标 CSV：只含聚合数字，天然脱敏。 */
export function buildStatsCsv(store: Store): string {
  const header = [
    "date", "contribution", "wordsAdded", "wordsRemoved", "edits", "notesCreated",
    "tasksCompleted", "focusMinutes", "activeMinutes", "capturedWords", "aiWordsAdded",
  ];
  const rows = Object.keys(store.data.days)
    .sort()
    .map((key) => {
      const day = store.getDay(key);
      return [
        key, day.contribution, day.wordsAdded, day.wordsRemoved, day.edits, day.notesCreated,
        day.tasksCompleted, day.focusMinutes, day.activeMinutes, day.capturedWords, day.aiWordsAdded,
      ].map(csvEscape).join(",");
    });
  return [header.join(","), ...rows].join("\n");
}

/**
 * JSON 导出：永不包含访问令牌等设置项；
 * 速记正文与文件路径默认剔除，需显式勾选才导出。
 */
export function buildExportJson(store: Store, options: ExportOptions): string {
  const memos = store.data.memos.map((memo) => ({
    id: memo.id,
    date: memo.date,
    time: memo.time,
    tags: memo.tags,
    converted: memo.converted,
    archived: Boolean(memo.archived),
    ...(options.includeMemoText ? { text: memo.text } : {}),
    ...(options.includePaths && memo.sourcePath
      ? { sourcePath: memo.sourcePath, sourceLine: memo.sourceLine ?? 0 }
      : {}),
    ...(options.includePaths && memo.resultPath ? { resultPath: memo.resultPath } : {}),
  }));
  const workLogs = store.data.workLogs.map((log) => ({
    id: log.id,
    date: log.date,
    time: log.time,
    agent: log.agent,
    task: log.task,
    summary: log.summary,
    decisions: log.decisions,
    learnings: log.learnings,
    openQuestions: log.openQuestions,
    tags: log.tags,
    ...(options.includePaths ? { files: log.files } : {}),
  }));
  const payload = {
    exportedAt: new Date().toISOString(),
    plugin: "sediment",
    sanitization: {
      memoText: options.includeMemoText ? "included" : "removed",
      paths: options.includePaths ? "included" : "removed",
      secrets: "never-exported",
    },
    days: store.data.days,
    memos,
    workLogs,
    focusSessions: store.data.focusSessions ?? [],
  };
  return JSON.stringify(payload, null, 2);
}

/** 审计包：变更时间线的 JSON / CSV 导出。路径默认以短哈希代替，需显式勾选才包含原文。 */
export function buildAuditExport(store: Store, options: ExportOptions): string {
  const events = buildChangeTimeline(store.data);
  const showPath = (path: string): string =>
    options.includePaths ? path : path ? `path:${contentHash(path).slice(0, 10)}` : "";
  const rows = events.map((event) => ({
    time: event.time,
    kind: event.kind,
    agent: event.agent,
    tool: event.tool,
    path: showPath(event.path),
    title: event.title,
    decision: event.decision ?? "",
    hash: event.hash ?? "",
    snapshotId: event.snapshotId ?? "",
    pendingId: event.pendingId ?? "",
    status: event.status ?? "",
  }));

  if (options.format === "csv") {
    const header = ["time", "kind", "agent", "tool", "path", "title", "decision", "hash", "snapshotId", "pendingId", "status"];
    return [
      header.join(","),
      ...rows.map((row) => header.map((key) => csvEscape(row[key as keyof typeof row])).join(",")),
    ].join("\n");
  }

  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      plugin: "sediment",
      kind: "audit-bundle",
      sanitization: {
        paths: options.includePaths ? "included" : "hashed",
        secrets: "never-exported",
      },
      events: rows,
    },
    null,
    2
  );
}

/** 写入库内 sediment-export/ 目录，返回文件路径。 */
export async function exportData(
  store: Store,
  vault: Vault,
  options: ExportOptions
): Promise<string> {
  const folder = normalizeFolder("sediment-export");
  await ensureFolder(vault, folder);
  const stamp = dateKey(new Date());
  const extension = options.format === "csv" ? "csv" : "json";
  const prefix = options.audit ? "sediment-audit" : "sediment";
  let path = `${folder}/${prefix}-${stamp}.${extension}`;
  let counter = 2;
  while (vault.getAbstractFileByPath(path)) {
    path = `${folder}/${prefix}-${stamp}-${counter}.${extension}`;
    counter += 1;
  }
  const content = options.audit
    ? buildAuditExport(store, options)
    : options.format === "csv" ? buildStatsCsv(store) : buildExportJson(store, options);
  await vault.create(path, content);
  return path;
}