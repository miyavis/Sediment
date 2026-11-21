import type { SedimentPlugin } from "../main";
import { t, tf } from "../i18n";
import { normalizeFolder } from "../utils/vault";

export type HealthKind =
  | "orphan"
  | "broken-link"
  | "stale"
  | "draft-stale"
  | "duplicate-title"
  | "empty-note";

export interface HealthIssue {
  kind: HealthKind;
  path: string;
  detail: string;
}

const STALE_DAYS = 90;
const DRAFT_STALE_DAYS = 14;
const EMPTY_NOTE_SIZE = 16;
const MAX_ISSUES = 300;

/**
 * 笔记健康度扫描：孤儿笔记（无出链也无入链）、断链（指向不存在的笔记）、
 * 久未更新（超过 90 天）、草稿滞留（知识库草稿超过 14 天未采纳）、
 * 疑似重复（同名笔记）、空壳笔记（内容几乎为空）。插件自身产出目录不参与扫描。
 * 发现的问题可一键转成 #to-agent 速记任务，交给智能体整理，形成闭环。
 */
export function scanNoteHealth(plugin: SedimentPlugin): HealthIssue[] {
  const settings = plugin.store.settings;
  const excluded = [
    settings.dailyNoteFolder,
    settings.reviewFolder,
    settings.workLogFolder,
    settings.backupFolder,
  ]
    .map(normalizeFolder)
    .filter((folder) => folder.length > 0);

  const resolved = plugin.app.metadataCache.resolvedLinks ?? {};
  const unresolved = plugin.app.metadataCache.unresolvedLinks ?? {};
  const backlinkCount = new Map<string, number>();
  for (const links of Object.values(resolved)) {
    for (const target of Object.keys(links)) {
      backlinkCount.set(target, (backlinkCount.get(target) ?? 0) + 1);
    }
  }

  const titleCount = new Map<string, string[]>();
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (excluded.some((folder) => file.path.startsWith(`${folder}/`))) continue;
    const key = file.basename.toLowerCase();
    const list = titleCount.get(key) ?? [];
    list.push(file.path);
    titleCount.set(key, list);
  }
  const knowledgeBase = normalizeFolder(settings.knowledgeFolder);

  const issues: HealthIssue[] = [];
  const staleBefore = Date.now() - STALE_DAYS * 86400000;
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (excluded.some((folder) => file.path.startsWith(`${folder}/`))) continue;
    const outgoing = Object.keys(resolved[file.path] ?? {}).length;
    const incoming = backlinkCount.get(file.path) ?? 0;
    if (outgoing === 0 && incoming === 0) {
      issues.push({ kind: "orphan", path: file.path, detail: t("没有出链也没有反链，可能是一座孤岛") });
    }
    const broken = Object.keys(unresolved[file.path] ?? {});
    if (broken.length > 0) {
      issues.push({
        kind: "broken-link",
        path: file.path,
        detail: tf("断链：{links}", {
          links: `${broken.slice(0, 3).join(", ")}${broken.length > 3 ? ` ${tf("等 {n} 处", { n: broken.length })}` : ""}`,
        }),
      });
    }
    if (file.stat.mtime < staleBefore && (outgoing > 0 || incoming > 0)) {
      const days = Math.floor((Date.now() - file.stat.mtime) / 86400000);
      issues.push({ kind: "stale", path: file.path, detail: tf("已 {days} 天未更新", { days }) });
    }
    if (
      knowledgeBase &&
      file.path.startsWith(`${knowledgeBase}/`) &&
      plugin.app.metadataCache.getFileCache(file)?.frontmatter?.sediment_status === "draft" &&
      file.stat.mtime < Date.now() - DRAFT_STALE_DAYS * 86400000
    ) {
      const days = Math.floor((Date.now() - file.stat.mtime) / 86400000);
      issues.push({ kind: "draft-stale", path: file.path, detail: tf("草稿已滞留 {days} 天，待审核采纳", { days }) });
    }
    const sameTitle = titleCount.get(file.basename.toLowerCase()) ?? [];
    if (sameTitle.length > 1) {
      const others = sameTitle.filter((path) => path !== file.path).slice(0, 3);
      issues.push({
        kind: "duplicate-title",
        path: file.path,
        detail: tf("与 {others} 标题疑似重复", { others: others.join(", ") }),
      });
    }
    if (file.stat.size < EMPTY_NOTE_SIZE) {
      issues.push({ kind: "empty-note", path: file.path, detail: t("内容几乎为空") });
    }
    if (issues.length >= MAX_ISSUES) break;
  }
  const order: Record<HealthKind, number> = {
    "broken-link": 0,
    "draft-stale": 1,
    "duplicate-title": 2,
    orphan: 3,
    "empty-note": 4,
    stale: 5,
  };
  return issues.sort((a, b) => order[a.kind] - order[b.kind]);
}

export const HEALTH_LABEL: Record<HealthKind, string> = {
  orphan: "孤儿笔记",
  "broken-link": "断链",
  stale: "久未更新",
  "draft-stale": "草稿滞留",
  "duplicate-title": "疑似重复",
  "empty-note": "空壳笔记",
};

/** 把健康问题转成 #to-agent 速记任务；已有相同未完成任务时跳过。返回新建数量。 */
export async function delegateHealthIssues(
  plugin: SedimentPlugin,
  issues: HealthIssue[]
): Promise<number> {
  let created = 0;
  for (const issue of issues.slice(0, 50)) {
    const text = tf(
      "【笔记健康】{label}：{path}（{detail}）。请整理：补双链/修断链/更新或归档，完成后用 complete_agent_task 关联产出。",
      { label: t(HEALTH_LABEL[issue.kind]), path: issue.path, detail: issue.detail }
    );
    const duplicate = plugin.store.data.memos.some(
      (memo) => memo.text === text && !memo.converted && !memo.archived
    );
    if (duplicate) continue;
    const memo = await plugin.memos.add(text, ["to-agent", "note-health"]);
    if (memo) created += 1;
  }
  return created;
}