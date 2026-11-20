import type { SedimentPlugin } from "../main";
import { normalizeFolder } from "../utils/vault";

export interface SemanticHit {
  path: string;
  score: number;
  snippet: string;
  matchType: "semantic";
  matchSource: "tf-idf";
}

const STOP_WORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "因为", "所以", "但是", "如果", "可以",
  "已经", "还是", "一个", "一些", "不是", "没有", "就是", "而且", "然后", "以及",
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "you",
  "your", "our", "has", "have", "had", "but", "not", "into", "about",
]);

const SYNONYM_GROUPS: string[][] = [
  ["配置", "设置", "设定", "config", "option", "setup"],
  ["报错", "错误", "异常", "失败", "error", "exception"],
  ["复盘", "总结", "回顾", "review", "retro"],
  ["知识库", "笔记库", "vault", "知识管理"],
  ["搜索", "检索", "查找", "search", "query"],
  ["沉淀", "积累", "归档", "deposit", "archive"],
  ["任务", "待办", "todo", "task"],
  ["专注", "番茄", "focus", "pomodoro"],
  ["文档", "说明", "手册", "doc", "documentation"],
  ["开发", "编程", "coding", "development"],
];

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    const expanded = SYNONYMS.get(word) ?? [];
    for (const other of group) if (other !== word && !expanded.includes(other)) expanded.push(other);
    SYNONYMS.set(word, expanded);
  }
}

export function tokenizeSemanticText(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length > 1) tokens.push(word);
  }
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

function expand(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYMS.get(token) ?? []) expanded.add(synonym);
  }
  return [...expanded];
}

/**
 * 纯本地的 TF-IDF 向量检索，带中文双字切分和轻量同义词扩展。
 * 不联网、不下载模型，索引常驻内存，vault 变化时可失效重建。
 */
export class SemanticIndex {
  private vectors = new Map<string, Map<string, number>>();
  private documentFrequency = new Map<string, number>();
  private documents = 0;
  private dirty = true;
  private buildPromise: Promise<void> | null = null;

  constructor(private plugin: SedimentPlugin) {}

  invalidate(): void {
    this.dirty = true;
  }

  private deniedFolders(): string[] {
    return this.plugin.store.settings.deniedFolders
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private deniedTags(): string[] {
    return this.plugin.store.settings.deniedTags
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private async buildOnce(): Promise<void> {
    const vault = this.plugin.app.vault;
    const folders = this.deniedFolders();
    const deniedTags = this.deniedTags();
    const files = vault.getMarkdownFiles().filter((file) => {
      if (folders.some((folder) => file.path === folder || file.path.startsWith(`${folder}/`))) return false;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const tags = [...(cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, ""))];
      const frontmatterTags = cache?.frontmatter?.tags;
      if (Array.isArray(frontmatterTags)) tags.push(...frontmatterTags.map(String));
      return !tags.some((tag) => deniedTags.includes(tag.replace(/^#/, "")));
    });

    this.vectors.clear();
    this.documentFrequency.clear();
    this.documents = files.length;
    const rawCounts = new Map<string, Map<string, number>>();
    for (const file of files) {
      const text = await vault.cachedRead(file);
      const tokens = tokenizeSemanticText(text);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      rawCounts.set(file.path, counts);
      for (const token of counts.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
    for (const [path, counts] of rawCounts) {
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
      const vector = new Map<string, number>();
      for (const [token, count] of counts) {
        const idf = Math.log(1 + this.documents / (1 + (this.documentFrequency.get(token) ?? 0)));
        vector.set(token, (count / total) * idf);
      }
      this.vectors.set(path, vector);
    }
  }

  private async build(): Promise<void> {
    if (!this.dirty) return;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      do {
        this.dirty = false;
        await this.buildOnce();
      } while (this.dirty);
    })().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  private vectorFor(tokens: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const token of expand(tokens)) counts.set(token, (counts.get(token) ?? 0) + 1);
    const vector = new Map<string, number>();
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
    for (const [token, count] of counts) {
      const idf = Math.log(1 + this.documents / (1 + (this.documentFrequency.get(token) ?? 0)));
      vector.set(token, (count / total) * idf);
    }
    return vector;
  }

  private cosine(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const value of a.values()) normA += value * value;
    for (const [key, value] of b) {
      normB += value * value;
      dot += (a.get(key) ?? 0) * value;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async search(query: string, limit = 10): Promise<SemanticHit[]> {
    const started = performance.now();
    await this.build();
    const queryVector = this.vectorFor(tokenizeSemanticText(query));
    if (queryVector.size === 0) return [];

    const results: SemanticHit[] = [];
    for (const [path, documentVector] of this.vectors) {
      const score = this.cosine(documentVector, queryVector);
      if (score <= 0) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      let snippet = "";
      if (file && "extension" in file) {
        const text = await this.plugin.app.vault.cachedRead(file as import("obsidian").TFile);
        const needle = tokenizeSemanticText(query)[0] ?? "";
        const position = needle ? text.toLowerCase().indexOf(needle) : -1;
        const start = Math.max(0, position - 60);
        snippet = text.slice(start, start + 220).replace(/\s+/g, " ").trim();
      }
      results.push({ path, score, snippet, matchType: "semantic", matchSource: "tf-idf" });
    }
    const ranked = results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
    const elapsed = performance.now() - started;
    if (elapsed > 80) {
      this.plugin.store.logDiagnostic(
        "performance",
        `语义检索耗时 ${elapsed.toFixed(0)}ms`,
        `notes=${this.vectors.size} results=${ranked.length}`
      );
    }
    return ranked;
  }
}
