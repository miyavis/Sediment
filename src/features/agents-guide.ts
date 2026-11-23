/** 一键把 AGENTS.md 放进库根，让编码 Agent 走 Sediment MCP 写入（护城河的产品化入口）。 */

import type { Vault } from "obsidian";

/** 精简版规则；与 examples/AGENTS.md 同源意图，内嵌避免运行时读取文件。 */
export const AGENTS_GUIDE = `# 在这个知识库里工作的规则

本库由 Obsidian 插件 **Sediment** 管理。Agent 对库的读写应通过 Sediment 提供的 MCP 工具（get_active_context / read_note / list_notes / search_notes / write_note / patch_note / add_memo / add_knowledge / record_work_log / manage_tasks），而不是直接操作文件系统。

## 必须遵守
- **一律通过 MCP 写入**：直接写文件会绕过统计、快照与审计链。
- **草稿需人工审批**：默认工作模式为 confirm，写入会挂起为待审草稿，等待主人采纳后才落盘。不要试图绕过审批。
- **不要记录令牌**：不要把 API 令牌、密钥写进任何笔记。
- **先读上下文**：写入前先用 get_active_context / get_daily_context 了解当前状态，避免覆盖他人内容。

## 建议
- 用 record_work_log 记录每次会话的结论、决策与开放问题。
- 用 add_knowledge 沉淀可复用知识，并标注来源。
- 批量任务用 manage_tasks 统一管理。

这套约定让所有写入可追溯、可回滚。详见 Sediment 插件说明。
`;

/** 若库根尚无 AGENTS.md，则写入；已存在则不覆盖，返回是否写入。 */
export function installAgentsGuide(vault: Vault): boolean {
  if (vault.getAbstractFileByPath("AGENTS.md")) return false;
  void vault.create("AGENTS.md", AGENTS_GUIDE);
  return true;
}
