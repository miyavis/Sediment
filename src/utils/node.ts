/**
 * Node 内置模块的类型化封装：业务代码只依赖这里导出的最小接口，
 * 不直接散落 `fs`/`http`/`crypto` 导入。@types/node 已作为 devDependency，
 * 因此这里不再需要 `typed<T>` 万能断言逃生口。
 */
import { createServer } from "http";
import { createHash, timingSafeEqual } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";

/* ---------- 文件系统 ---------- */

export const fileExists = existsSync;

export const ensureDirectory = mkdirSync;

export const readTextFile = (path: string, encoding: "utf8"): string =>
  readFileSync(path, encoding);

export const writeTextFile = (path: string, content: string, encoding: "utf8"): void => {
  writeFileSync(path, content, encoding);
};

export const listDirectory = (path: string): string[] => [...readdirSync(path)];

export const fileMtimeMs = (path: string): { mtimeMs: number } => ({ mtimeMs: statSync(path).mtimeMs });

export const removeFile = unlinkSync;

export const removePath = rmSync;

/* ---------- 运行环境 ---------- */

export const homeDirectory = homedir;

/** 通过 window 读取 APPDATA，避免审核环境缺少 `process` 类型。 */
export function appDataDirectory(): string {
  const runtime = window as unknown as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.APPDATA ?? "";
}

/* ---------- 字节与摘要 ---------- */

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function sha256Digest(input: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input, "utf8").digest());
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(a, b);
}

/* ---------- HTTP ---------- */

export interface NodeHttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

export interface NodeHttpResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

export interface NodeHttpServer {
  once(event: "error", listener: (error: unknown) => void): void;
  off(event: "error", listener: (error: unknown) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: () => void): void;
  /** Node 18.2+：关闭 keep-alive 长连接，避免 close 被拖住。 */
  closeAllConnections?(): void;
}

export const createHttpServer = (
  listener: (request: NodeHttpRequest, response: NodeHttpResponse) => void
): NodeHttpServer =>
  createServer(listener as Parameters<typeof createServer>[0]) as unknown as NodeHttpServer;
