/** Ollama 本地 embedding 客户端：请求函数注入，生产用 obsidian requestUrl，测试用假函数。 */
export interface EmbeddingRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

export interface EmbeddingResponse {
  status: number;
  json: unknown;
}

export type RequestFn = (options: EmbeddingRequestOptions) => Promise<EmbeddingResponse>;

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "") || "http://127.0.0.1:11434";
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 内容哈希（djb2 + 长度），用于增量向量缓存。 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${hash >>> 0}:${text.length}`;
}

export class OllamaEmbeddingClient {
  constructor(
    private endpoint: string,
    private model: string,
    private request: RequestFn
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.request({
      url: `${normalizeEndpoint(this.endpoint)}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(`Ollama embed HTTP ${response.status}`);
    const embeddings = (response.json as { embeddings?: unknown } | null)?.embeddings;
    const valid =
      Array.isArray(embeddings) &&
      embeddings.length === texts.length &&
      embeddings.every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length > 0 &&
          vector.every((value) => typeof value === "number" && Number.isFinite(value))
      );
    if (!valid) throw new Error("Ollama embed 返回格式非法");
    return embeddings as number[][];
  }
}
