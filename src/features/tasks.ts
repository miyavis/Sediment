import { TFile } from "obsidian";
import type { SedimentPlugin } from "../main";
import { dailyNotePath, dateKey } from "../utils/dates";
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

/** 待办读源的访问约束：Agent 调用面传入谓词过滤越权路径，人用 UI 不传即不过滤。 */
export interface TaskReadOptions {
  accessible?: (path: string) => boolean;
}

const CHECKBOX = /^(\s*[-*+]\s+)\[([ xX])\]\s+(.*)$/;
/** 非日记笔记里的复选框默认不算待办；写 #task / #todo 才显式纳入。 */
const TASK_TAG = /(^|\s)#(task|todo)\b/i;
/** 模板里的“检查清单/完成标准”是占位内容，永远不当成待办。 */
const TEMPLATE_FOLDER = /(^|\/)[Tt]emplates\//;

function inFolder(path: string, folder: string): boolean {
  if (!folder) return /^[^/]*\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(path);
  return path === folder || path.startsWith(`${folder}/`);
}

/** 把一行复选框置为已勾选（供落盘与待审预览共用，避免两份实现漂移）。 */
export function toggleCheckboxLine(line: string): string {
  return line.replace(CHECKBOX, (_full, prefix: string, _state: string, text: string) => `${prefix}[x] ${text}`);
}

/** 扫描 vault 里的 Obsidian 原生待办，不另存一份数据。 */
export class TaskManager {
  constructor(private plugin: SedimentPlugin) {}

  private dateOf(file: TFile): string {
    const match = file.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    return dateKey(new Date(file.stat.ctime));
  }

  /** 日记目录是默认任务源；其它笔记只有显式写 #task / #todo 才扫描。 */
  private isTaskSource(path: string, text: string, dailyFolder: string): boolean {
    if (TEMPLATE_FOLDER.test(path)) return false;
    return inFolder(path, dailyFolder) || TASK_TAG.test(text);
  }

  /** 速记委派的 Agent 任务（不读库）。 */
  private agentTasks(): TaskItem[] {
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

  /** 单次全库扫描：拿到所有原生复选框，后续按作用域分组，避免同一页签重复读库。 */
  private async scanFileTasks(opts: TaskReadOptions): Promise<TaskItem[]> {
    const dailyFolder = normalizeFolder(this.plugin.store.settings.dailyNoteFolder);
    const result: TaskItem[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (opts.accessible && !opts.accessible(file.path)) continue;
      const text = await this.plugin.app.vault.cachedRead(file);
      if (!this.isTaskSource(file.path, text, dailyFolder)) continue;
      const date = this.dateOf(file);
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(CHECKBOX);
        if (!match) continue;
        result.push({
          path: file.path,
          line: index + 1,
          text: match[3].trim(),
          date,
          checked: match[2].toLowerCase() === "x",
        });
      }
    }
    return result;
  }

  /** 今日/遗留/Agent 三组一次扫描完成（今日页渲染专用）。 */
  async listGrouped(opts: TaskReadOptions = {}): Promise<{ today: TaskItem[]; overdue: TaskItem[]; agent: TaskItem[] }> {
    const all = await this.scanFileTasks(opts);
    const today = dateKey(new Date());
    return {
      today: all.filter((task) => task.date === today),
      overdue: all.filter((task) => !task.checked && task.date < today),
      agent: this.agentTasks(),
    };
  }

  async list(scope: "today" | "overdue" | "all" | "agent" = "all", opts: TaskReadOptions = {}): Promise<TaskItem[]> {
    if (scope === "agent") return this.agentTasks();
    const all = await this.scanFileTasks(opts);
    const today = dateKey(new Date());
    if (scope === "today") return all.filter((task) => task.date === today);
    if (scope === "overdue") return all.filter((task) => !task.checked && task.date < today);
    return all;
  }

  async complete(path: string, line: number): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${path}`);
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const index = line - 1;
      if (index < 0 || index >= lines.length) throw new Error(`行号超出范围：${line}`);
      lines[index] = toggleCheckboxLine(lines[index]);
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
  async snapshot(opts: TaskReadOptions & { date?: Date } = {}): Promise<number> {
    const overdue = (await this.list("overdue", opts)).filter((item) => !item.checked);
    if (overdue.length === 0) return 0;

    // 落盘路径走 dailyNotePath 统一口径；调用方传同一 date 实例即可与门禁校验一致。
    const settings = this.plugin.store.settings;
    const folder = normalizeFolder(settings.dailyNoteFolder);
    const date = opts.date ?? new Date();
    const today = dateKey(date);
    const path = dailyNotePath(settings, date);
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
