/** Agent 访问策略的纯规则：判定路径/操作是否允许，不依赖 Obsidian 或插件状态。 */

export type AgentOperation = "read" | "create" | "patch" | "overwrite" | "delete";

/** 访问判定所需的最小设置子集（便于单测构造）。 */
export interface AccessSettings {
  deniedFolders: string;
  deniedTags: string;
  agentAccessMode: "allow-all" | "allowlist";
  agentAllowedFolders: string;
  agentAllowRead: boolean;
  agentAllowCreate: boolean;
  agentAllowPatch: boolean;
  agentAllowOverwrite: boolean;
  agentAllowDelete: boolean;
}

export function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 路径是否命中黑名单目录（相等或其子路径）。 */
export function isPathDenied(path: string, deniedFolders: string): boolean {
  return splitList(deniedFolders).some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** 操作是否被工作模式允许。 */
export function isOperationAllowed(operation: AgentOperation, settings: AccessSettings): boolean {
  switch (operation) {
    case "read":
      return settings.agentAllowRead;
    case "create":
      return settings.agentAllowCreate;
    case "patch":
      return settings.agentAllowPatch;
    case "overwrite":
      return settings.agentAllowOverwrite;
    case "delete":
      return settings.agentAllowDelete;
  }
}

/** 路径是否在当前访问模式下可达（黑名单 + 白名单）。 */
export function isPathAllowedByMode(path: string, settings: AccessSettings): boolean {
  if (isPathDenied(path, settings.deniedFolders)) return false;
  if (settings.agentAccessMode !== "allowlist") return true;
  return splitList(settings.agentAllowedFolders).some(
    (folder) => path === folder || path.startsWith(`${folder}/`)
  );
}

/** 根据设置解析出知识库分类列表。 */
export function listCategories(knowledgeCategories: string): string[] {
  return knowledgeCategories
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const CATEGORY_RULES: Array<[string, RegExp]> = [
  ["复盘", /复盘|总结|周报|回顾|小结|review|retro/],
  ["项目", /项目|计划|需求|进度|里程碑|project|任务拆解/],
  ["技术", /代码|插件|api|mcp|配置|报错|调试|开发|构建|故障|排查|排错|发布|维护|bug|error|code|build|技术/],
  ["方法", /工作流|提示词|步骤|规范|指南|流程|方法|workflow|prompt|howto|教程/],
  ["灵感", /想法|灵感|点子|随想|idea/],
];

/** 根据标题、标签与正文推断分类；无匹配时回退到第一个配置分类。 */
export function inferCategory(
  title: string,
  content: string,
  tags: string[],
  categories: string[]
): string {
  const text = `${title} ${tags.join(" ")} ${content.slice(0, 600)}`.toLowerCase();
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return categories[0] ?? "未分类";
}
