/** AgentApi 使用的纯函数：文本 diff / frontmatter / 来源登记。无状态，可单测。 */

export function versionOf(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 极简 unified diff：显示首个差异到末个差异之间的增删行。 */
export function simpleDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const lines = ["--- before", "+++ after"];
  for (let index = start; index < endOld; index += 1) lines.push(`-${oldLines[index]}`);
  for (let index = start; index < endNew; index += 1) lines.push(`+${newLines[index]}`);
  return lines.join("\n");
}

export function lineChanges(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  return {
    addedLines: newLines.filter((line) => !oldLines.includes(line)).length,
    removedLines: oldLines.filter((line) => !newLines.includes(line)).length,
  };
}

export function findSection(
  text: string,
  heading: string,
  index: number
): { start: number; end: number; lines: string[] } | null {
  const lines = text.split("\n");
  const headingMatch = heading.match(/^(#{1,6})\s+(.*)$/);
  const level = headingMatch ? headingMatch[1].length : 0;
  const target = headingMatch ? headingMatch[2].trim() : heading.trim();
  const matches: Array<{ line: number; level: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!match) continue;
    if (match[2].trim() === target && (level === 0 || match[1].length === level)) {
      matches.push({ line: i, level: match[1].length });
    }
  }
  const chosen = matches[index];
  if (!chosen) return null;
  let end = lines.length;
  for (let i = chosen.line + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= chosen.level) {
      end = i;
      break;
    }
  }
  return { start: chosen.line + 1, end, lines };
}

/** 纯函数：在笔记全文上应用 frontmatter 字段更新，供直接写与待审预览共用。 */
export function applyFrontmatterUpdate(text: string, updates: Record<string, unknown>): string {
  const lines = text.split("\n");
  let start = -1;
  let end = -1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("frontmatter 未闭合");
    start = 1;
  }
  const block = start >= 0 ? lines.slice(start, end) : [];
  for (const [key, value] of Object.entries(updates)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const targetIndex = block.findIndex((line) => new RegExp(`^${escaped}\\s*:`).test(line));
    const replacement = Array.isArray(value)
      ? value.length
        ? [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(String(item))}`)]
        : [`${key}: []`]
      : [`${key}: ${JSON.stringify(value)}`];
    if (targetIndex >= 0) block.splice(targetIndex, 1, ...replacement);
    else block.push(...replacement);
  }
  return start >= 0
    ? [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n")
    : ["---", ...block, "---", "", ...lines].join("\n");
}

/** 知识目录内的 Agent 新建笔记补登记来源；已有 source 时不覆盖（保留人工登记）。纯函数。 */
export function stampAgentProvenance(content: string, agent: string, today: string): string {
  const head = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  // 首行像 frontmatter 但未闭合：不猜测结构，原样放行（交给人工整理）。
  if (!head && /^---\r?\n/.test(content)) return content;
  if (head && /^source\s*:/m.test(head[0])) return content;
  const updates: Record<string, unknown> = { source: "agent", sediment_status: "draft", agent };
  if (!head || !/^type\s*:/m.test(head[0])) updates.type = "knowledge";
  if (!head || !/^date\s*:/m.test(head[0])) updates.date = today;
  return applyFrontmatterUpdate(content, updates);
}
