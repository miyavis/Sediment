import { TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import { dateKey } from "../utils/dates";
import { ensureFolder, normalizeFolder } from "../utils/vault";

export interface TaskItem {
  path: string;
  line: number;
  text: string;
  date: string;
  checked: boolean;
  /** Agent 任务：来源复选框与速记 id */
  sourcePath?: string;
  sourceLine?: number;
  memoId?: string;
}

const CHECKBOX = /^(\s*[-*+]\s+)\[([ xX])\]\s+(.*)$/;

/** 扫描 vault 里的 Obsidian 原生待办，不另存一份数据。 */
export class TaskManager {
  constructor(private plugin: SedimentPlugin) {}

  private dateOf(file: TFile): string {
    const match = file.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    return dateKey(new Date(file.stat.ctime));
  }

  async list(scope: "today" | "overdue" | "all" | "agent" = "all"): Promise<TaskItem[]> {
    if (scope === "agent") {
      return this.plugin.store.data.memos
        .filter((memo) => memo.tags.includes("to-agent") && !memo.converted && !memo.archived)
        .map((memo) => ({
          path: "",
          line: 0,
          text: memo.text,
          date: memo.date,
          checked: false,
          sourcePath: memo.sourcePath,
          sourceLine: memo.sourceLine,
          memoId: memo.id,
        }));
    }
    const today = dateKey(new Date());
    const result: TaskItem[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const text = await this.plugin.app.vault.cachedRead(file);
      const date = this.dateOf(file);
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(CHECKBOX);
        if (!match) continue;
        const checked = match[2].toLowerCase() === "x";
        if (scope === "today" && date !== today) continue;
        if (scope === "overdue" && (checked || date >= today)) continue;
        result.push({
          path: file.path,
          line: index + 1,
          text: match[3].trim(),
          date,
          checked,
        });
      }
    }
    return result;
  }

  async complete(path: string, line: number): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${path}`);
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const index = line - 1;
      if (index < 0 || index >= lines.length) throw new Error(`行号超出范围：${line}`);
      lines[index] = lines[index].replace(CHECKBOX, (_full, prefix: string, state: string, text: string) =>
        `${prefix}[x] ${text}`
      );
      return lines.join("\n");
    });
  }

  async delegate(path: string, line: number): Promise<string> {
    const tasks = await this.list("all");
    const task = tasks.find((item) => item.path === path && item.line === line);
    if (!task) throw new Error(`找不到待办：${path}:${line}`);
    const memo = await this.plugin.memos.add(task.text, ["to-agent"], {
      path: task.path,
      line: task.line,
    });
    if (!memo) throw new Error("创建 Agent 任务失败");
    return memo.id;
  }

  /** 按需把遗留待办写入当天日记，不默认执行。 */
  async snapshot(): Promise<number> {
    const overdue = (await this.list("overdue")).filter((item) => !item.checked);
    if (overdue.length === 0) return 0;

    const settings = this.plugin.store.settings;
    const folder = normalizeFolder(settings.dailyNoteFolder);
    const today = dateKey(new Date());
    const name = settings.dailyNoteFormat
      .replace(/YYYY/g, String(new Date().getFullYear()))
      .replace(/MM/g, String(new Date().getMonth() + 1).padStart(2, "0"))
      .replace(/DD/g, String(new Date().getDate()).padStart(2, "0"));
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    await ensureFolder(this.plugin.app.vault, folder);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    const file =
      existing instanceof TFile
        ? existing
        : await this.plugin.app.vault.create(path, `# ${today}\n\n`);
    const grouped = new Map<string, string[]>();
    for (const task of overdue) {
      const group = grouped.get(task.date) ?? [];
      group.push(`- [ ] ${task.text}（来自 \`${task.path}\`）`);
      grouped.set(task.date, group);
    }
    const lines = [`## 遗留待办 · ${today}`, ""];
    for (const [date, items] of grouped) {
      lines.push(`### ${date}`, ...items, "");
    }
    await this.plugin.app.vault.process(file, (data) => `${data.trimEnd()}\n\n${lines.join("\n")}`);
    return overdue.length;
  }
}
