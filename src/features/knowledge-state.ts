import { dateKey } from "../utils/dates";
import { normalizeFolder } from "../utils/vault";

export interface KnowledgeFile {
  path: string;
  mtime: number;
  frontmatter?: Record<string, unknown>;
}

export interface KnowledgeState {
  total: number;
  drafts: number;
  accepted: number;
  agentSourced: number;
  humanSourced: number;
  unregistered: number;
  unregisteredPaths: string[];
  categories: Array<{ name: string; count: number }>;
  lastUpdated: string | null;
}

/**
 * 知识库现状（实时扫描口径，与历史活动统计互补）：
 * 删除/移动立即反映；source 缺失只记「未登记」，不定罪、不影响其它统计。
 * 纯函数：调用方负责把 vault 文件与 frontmatter 映射成 KnowledgeFile。
 */
export function scanKnowledgeState(files: KnowledgeFile[], knowledgeFolder: string): KnowledgeState {
  const base = normalizeFolder(knowledgeFolder);
  const prefix = base ? `${base}/` : "";
  const state: KnowledgeState = {
    total: 0,
    drafts: 0,
    accepted: 0,
    agentSourced: 0,
    humanSourced: 0,
    unregistered: 0,
    unregisteredPaths: [],
    categories: [],
    lastUpdated: null,
  };
  const categoryCount = new Map<string, number>();
  let latest = 0;
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    state.total += 1;
    const fm = file.frontmatter ?? {};
    if (fm.sediment_status === "draft") state.drafts += 1;
    if (fm.sediment_status === "accepted") state.accepted += 1;
    const source = typeof fm.source === "string" ? fm.source : "";
    if (source === "agent") state.agentSourced += 1;
    else if (source === "human") state.humanSourced += 1;
    else {
      state.unregistered += 1;
      if (state.unregisteredPaths.length < 20) state.unregisteredPaths.push(file.path);
    }
    const rest = prefix ? file.path.slice(prefix.length) : file.path;
    const category = rest.includes("/")
      ? rest.slice(0, rest.indexOf("/"))
      : typeof fm.category === "string" && fm.category
        ? fm.category
        : "(root)";
    categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
    if (file.mtime > latest) latest = file.mtime;
  }
  state.categories = [...categoryCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  state.lastUpdated = latest > 0 ? dateKey(new Date(latest)) : null;
  return state;
}
