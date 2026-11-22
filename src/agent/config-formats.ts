/** 客户端配置的格式适配：JSON / TOML / YAML。
 *  只做「读写一个 MCP 服务器条目」的最小操作，不引入解析依赖（保持发布产物零新增依赖）。
 *  TOML/YAML 为非结构化文本 upsert：定位目标段，替换或追加条目，其余内容原样保留。 */

export type ConfigFormat = "json" | "toml" | "yaml";

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 移除 TOML 中已有的 [mcp_servers.<id>] 及其子表（到下一个顶格 [ 段或文件尾）。 */
function stripTomlSection(raw: string, id: string): string {
  const lines = raw.split("\n");
  const header = `[mcp_servers.${id}]`;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header || trimmed.startsWith(`${header}.`)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** TOML：写入 [mcp_servers.<id>] 段，env 用内联表。 */
export function upsertTomlServer(raw: string, id: string, entry: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): string {
  const base = stripTomlSection(raw, id).replace(/\s+$/, "");
  const env = Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ");
  const args = entry.args.map(tomlString).join(", ");
  const block = [
    `[mcp_servers.${id}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${args}]`,
    `env = { ${env} }`,
  ].join("\n");
  return `${base}\n\n${block}\n`;
}

export function hasTomlServer(raw: string, id: string): boolean {
  return raw.split("\n").some((line) => line.trim() === `[mcp_servers.${id}]`);
}

function yamlScalar(value: string): string {
  // token 等含特殊字符的值统一加双引号，避免 YAML 解析歧义。
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlEntry(id: string, indent: string, entry: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): string[] {
  const lines = [
    `${indent}${id}:`,
    `${indent}  command: ${yamlScalar(entry.command)}`,
    `${indent}  args: [${entry.args.map(yamlScalar).join(", ")}]`,
    `${indent}  env:`,
  ];
  for (const [k, v] of Object.entries(entry.env)) lines.push(`${indent}    ${k}: ${yamlScalar(v)}`);
  return lines;
}

/** YAML：在 mcp_servers 段下写入 <id> 条目；段不存在则创建。只替换同名 id 的顶层条目。 */
export function upsertYamlServer(raw: string, id: string, entry: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  const idRe = new RegExp(`^(\\s*)${id}\\s*:`);
  let i = 0;
  let serversIndent: string | null = null;
  let done = false;

  while (i < lines.length) {
    const line = lines[i];
    const serverMatch = line.match(/^(\s*)mcp_servers\s*:\s*(.*)$/);
    if (serverMatch && serversIndent === null) {
      serversIndent = serverMatch[1];
      out.push(`${serverMatch[1]}mcp_servers:`);
      i += 1;
      // 若原来是 inline `mcp_servers: {}` 或 `mcp_servers: null`，其后内容即子项；逐行处理直到段结束。
      const childIndent = `${serversIndent}  `;
      while (i < lines.length) {
        const cur = lines[i];
        // 段结束：遇到缩进 <= serversIndent 的非空行
        if (cur.trim() && !/^\s/.test(cur) &&
            cur.match(/^(\s*)/)![1].length <= serversIndent.length) break;
        const idMatch = cur.match(idRe);
        if (idMatch && idMatch[1].length === childIndent.length) {
          // 跳过旧 id 条目及其子行（缩进更深）
          i += 1;
          while (i < lines.length && (lines[i].trim() === "" ||
                 /^(\s*)/.exec(lines[i])![1].length > idMatch[1].length)) i += 1;
          out.push(...yamlEntry(id, childIndent, entry));
          done = true;
          continue;
        }
        out.push(cur);
        i += 1;
      }
      if (!done) out.push(...yamlEntry(id, childIndent, entry));
      continue;
    }
    out.push(line);
    i += 1;
  }

  if (serversIndent === null) {
    out.push("mcp_servers:");
    out.push(...yamlEntry(id, "  ", entry));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function hasYamlServer(raw: string, id: string): boolean {
  return raw.split("\n").some((line) => new RegExp(`^\\s*${id}\\s*:`).test(line));
}

/** 从 TOML 移除 [mcp_servers.<id>] 段。 */
export function removeTomlServer(raw: string, id: string): string {
  return stripTomlSection(raw, id);
}

/** 从 YAML 的 mcp_servers 段移除 <id> 条目（含其子行）。 */
export function removeYamlServer(raw: string, id: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  const idRe = new RegExp(`^(\\s*)${id}\\s*:`);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idMatch = line.match(idRe);
    if (idMatch) {
      const indent = idMatch[1].length;
      i += 1;
      while (i < lines.length && (lines[i].trim() === "" ||
             (/^(\s*)/.exec(lines[i])![1].length > indent))) i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
