import { requestUrl } from "obsidian";
import type { SedimentPlugin } from "../main";
import type { PulseSettings } from "../types";
import { tf } from "../i18n";
import { isPathAllowedByMode, splitList } from "./access";
import { OllamaEmbeddingClient, cosineSimilarity, hashText, type RequestFn } from "./embedding";

export interface SemanticHit {
  path: string;
  score: number;
  snippet: string;
  matchType: "semantic";
  matchSource: "tf-idf" | "embedding";
}

/** 生产请求函数：Obsidian requestUrl（宿主代理，绕过 CORS），失败不抛、由客户端校验状态码。 */
const obsidianRequest: RequestFn = async (options) => {
  const response = await requestUrl({
    url: options.url,
    method: options.method,
    headers: options.headers,
    body: options.body,
    throw: false,
  });
  return { status: response.status, json: response.json };
};

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
 * 语义检索：默认纯本地的 TF-IDF 向量检索，带中文双字切分和轻量同义词扩展。
 * TF-IDF 默认不联网；可选 embedding 仅访问本机 Ollama 回环，不可用自动回退。
 * 索引常驻内存，vault 变化时可失效重建。
 */
export class SemanticIndex {
  private vectors = new Map<string, Map<string, number>>();
  private documentFrequency = new Map<string, number>();
  private documents = 0;
  private dirty = true;
  private buildPromise: Promise<void> | null = null;
  private embeddingVectors = new Map<string, number[]>();
  private embeddingCache = new Map<string, { hash: string; vector: number[] }>();
  private embeddingKey = "";
  private embeddingFailed = false;

  constructor(private plugin: SedimentPlugin, private request: RequestFn = obsidianRequest) {}

  invalidate(): void {
    this.dirty = true;
    // 允许下次重建时重试 embedding（Ollama 可能是临时不可用）。
    this.embeddingFailed = false;
  }

  private deniedTags(): string[] {
    return splitList(this.plugin.store.settings.deniedTags);
  }

  /** 语义索引必须与 Agent 访问策略同口径：黑名单目录 + 白名单模式统一走 access.ts。 */
  private isReachable(path: string): boolean {
    return isPathAllowedByMode(path, this.plugin.store.settings);
  }

  private async buildOnce(): Promise<void> {
    const vault = this.plugin.app.vault;
    const deniedTags = this.deniedTags();
    const files = vault.getMarkdownFiles().filter((file) => {
      if (!this.isReachable(file.path)) return false;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const tags = [...(cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, ""))];
      const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      const frontmatterTags = frontmatter.tags;
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

    if (this.plugin.store.settings.semanticEngine === "embedding") {
      try {
        await this.buildEmbeddings(files);
        this.embeddingFailed = false;
      } catch (error) {
        this.embeddingFailed = true;
        this.embeddingVectors.clear();
        this.plugin.store.logDiagnostic(
          "performance",
          tf("Embedding 不可用，已回退 TF-IDF：{error}", {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else {
      this.embeddingVectors.clear();
    }
  }

  /** 向量化：按 hash 增量缓存，只 embed 新增/变化文件；模型或地址变更时整体重建。 */
  private async buildEmbeddings(files: import("obsidian").TFile[]): Promise<void> {
    const settings = this.plugin.store.settings;
    const key = `${settings.embeddingEndpoint}|${settings.embeddingModel}`;
    if (key !== this.embeddingKey) {
      this.embeddingCache.clear();
      this.embeddingVectors.clear();
      this.embeddingKey = key;
    }
    const client = new OllamaEmbeddingClient(settings.embeddingEndpoint, settings.embeddingModel, this.request);
    const texts: string[] = [];
    const targets: Array<{ path: string; hash: string }> = [];
    const alive = new Set(files.map((file) => file.path));
    // 向量与缓存都按 alive 清理：失败清空只会清 embeddingVectors，缓存项需同步淘汰。
    const known = new Set([...this.embeddingVectors.keys(), ...this.embeddingCache.keys()]);
    for (const path of known) {
      if (!alive.has(path)) {
        this.embeddingVectors.delete(path);
        this.embeddingCache.delete(path);
      }
    }
    for (const file of files) {
      const text = (await this.plugin.app.vault.cachedRead(file)).slice(0, 2000);
      const hash = hashText(text);
      const cached = this.embeddingCache.get(file.path);
      if (cached && cached.hash === hash) {
        this.embeddingVectors.set(file.path, cached.vector);
        continue;
      }
      texts.push(text);
      targets.push({ path: file.path, hash });
    }
    const BATCH = 16;
    for (let start = 0; start < texts.length; start += BATCH) {
      const vectors = await client.embed(texts.slice(start, start + BATCH));
      for (let offset = 0; offset < vectors.length; offset += 1) {
        const target = targets[start + offset];
        this.embeddingCache.set(target.path, { hash: target.hash, vector: vectors[offset] });
        this.embeddingVectors.set(target.path, vectors[offset]);
      }
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
    if (!String(query ?? "").trim()) return [];
    await this.build();
    const cap = Math.max(1, Math.min(limit, 50));
    const settings = this.plugin.store.settings;
    let ranked: SemanticHit[] = [];
    if (settings.semanticEngine === "embedding" && !this.embeddingFailed && this.embeddingVectors.size > 0) {
      ranked = await this.searchByEmbedding(query, cap, settings);
    }
    if (ranked.length === 0) ranked = await this.searchByTfIdf(query, cap);
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

  private async searchByEmbedding(query: string, cap: number, settings: PulseSettings): Promise<SemanticHit[]> {
    try {
      const client = new OllamaEmbeddingClient(settings.embeddingEndpoint, settings.embeddingModel, this.request);
      const [queryVector] = await client.embed([query.slice(0, 2000)]);
      const scored: Array<{ path: string; score: number }> = [];
      for (const [path, vector] of this.embeddingVectors) {
        if (!this.isReachable(path)) continue;
        const score = cosineSimilarity(vector, queryVector);
        if (score <= 0) continue;
        scored.push({ path, score });
      }
      scored.sort((a, b) => b.score - a.score);
      // 先截断再取片段：只为最终命中的几条读正文，避免整库 cachedRead。
      const hits: SemanticHit[] = [];
      for (const { path, score } of scored.slice(0, cap)) {
        hits.push({
          path,
          score,
          snippet: await this.snippetFor(path, query),
          matchType: "semantic",
          matchSource: "embedding",
        });
      }
      return hits;
    } catch (error) {
      this.embeddingFailed = true;
      this.plugin.store.logDiagnostic(
        "performance",
        tf("Embedding 不可用，已回退 TF-IDF：{error}", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return [];
    }
  }

  private async searchByTfIdf(query: string, cap: number): Promise<SemanticHit[]> {
    const queryVector = this.vectorFor(tokenizeSemanticText(query));
    if (queryVector.size === 0) return [];
    const results: SemanticHit[] = [];
    for (const [path, documentVector] of this.vectors) {
      // 索引可能在设置收紧前建成；逐条再过一次门禁，宁可少不可漏。
      if (!this.isReachable(path)) continue;
      const score = this.cosine(documentVector, queryVector);
      if (score <= 0) continue;
      results.push({
        path,
        score,
        snippet: await this.snippetFor(path, query),
        matchType: "semantic",
        matchSource: "tf-idf",
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, cap);
  }

  private async snippetFor(path: string, query: string): Promise<string> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file)) return "";
    const text = await this.plugin.app.vault.cachedRead(file as import("obsidian").TFile);
    const needle = tokenizeSemanticText(query)[0] ?? "";
    const position = needle ? text.toLowerCase().indexOf(needle) : -1;
    const start = Math.max(0, position - 60);
    return text.slice(start, start + 220).replace(/\s+/g, " ").trim();
  }
}
