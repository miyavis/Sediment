/** 智能体工坊一次渲染内的全库扫描缓存：徽章、草稿卡、来源未登记卡共用，避免三次遍历。 */
import type { TFile } from "obsidian";
import type { SedimentPlugin } from "../../main";
import { scanKnowledgeState } from "../../features/knowledge-state";
import { frontmatterOf, normalizeFolder } from "../../utils/vault";

export interface ScannedFile {
  path: string;
  mtime: number;
  frontmatter: Record<string, unknown>;
}

export interface AgentScan {
  files: ScannedFile[];
  drafts: TFile[];
  unregisteredPaths: string[];
  unregistered: number;
}

/** 遍历一次 vault 元数据缓存，产出工坊各卡需要的全部口径。 */
export function scanAgentState(plugin: SedimentPlugin): AgentScan {
  const files: ScannedFile[] = [];
  const drafts: TFile[] = [];
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const frontmatter = frontmatterOf(plugin.app.metadataCache.getFileCache(file)) ?? {};
    files.push({ path: file.path, mtime: file.stat.mtime, frontmatter });
    if (frontmatter.sediment_status === "draft") drafts.push(file);
  }
  const knowledgeFolder = normalizeFolder(plugin.store.settings.knowledgeFolder);
  const state = knowledgeFolder
    ? scanKnowledgeState(files, knowledgeFolder)
    : { unregistered: 0, unregisteredPaths: [] };
  return {
    files,
    drafts,
    unregisteredPaths: state.unregisteredPaths,
    unregistered: state.unregistered,
  };
}
