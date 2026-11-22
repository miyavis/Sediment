/**
 * Node 内置模块的类型化封装。
 *
 * 审核环境通常只安装 `obsidian` 类型而没有 `@types/node`，直接导入 `fs`/`http`/
 * `crypto` 会被推断为 `any`，触发一串 `no-unsafe-*` 告警。这里把用到的 API
 * 收敛到一处并显式声明最小接口，其余模块只调用这些类型化函数。
 */
import { createServer as nodeCreateServer } from "http";
import { createHash as nodeCreateHash, timingSafeEqual as nodeTimingSafeEqual } from "crypto";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  rmSync as nodeRmSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "fs";
import { homedir as nodeHomedir } from "os";

/** 模块导入边界的类型适配：只在此处把无类型的 Node 导入标注为明确签名。 */
function typed<T>(value: unknown): T {
  return value as T;
}

/* ---------- 文件系统 ---------- */

export const fileExists = typed<(path: string) => boolean>(nodeExistsSync);

export const ensureDirectory = typed<(path: string, options: { recursive: boolean }) => void>(
  nodeMkdirSync
);

export const readTextFile = typed<(path: string, encoding: "utf8") => string>(nodeReadFileSync);

export const writeTextFile = typed<(
  path: string,
  content: string,
  encoding: "utf8"
) => void>(nodeWriteFileSync);

export const listDirectory = typed<(path: string) => string[]>(nodeReaddirSync);

export const fileMtimeMs = typed<(path: string) => { mtimeMs: number }>(nodeStatSync);

export const removeFile = typed<(path: string) => void>(nodeUnlinkSync);

export const removePath = typed<(
  path: string,
  options: { recursive: boolean; force: boolean }
) => void>(nodeRmSync);

/* ---------- 运行环境 ---------- */

export const homeDirectory = typed<() => string>(nodeHomedir);

/** 通过 window 读取 APPDATA，避免审核环境缺少 `process` 类型。 */
export function appDataDirectory(): string {
  const runtime = typed<{ process?: { env?: Record<string, string | undefined> } }>(
    typeof window === "undefined" ? {} : window
  );
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
  const createHash = typed<(algorithm: string) => {
    update(data: string, encoding: "utf8"): { digest(): Uint8Array };
  }>(nodeCreateHash);
  return createHash("sha256").update(input, "utf8").digest();
}

export const constantTimeEqual = typed<(a: Uint8Array, b: Uint8Array) => boolean>(
  nodeTimingSafeEqual
);

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

export const createHttpServer = typed<(
  listener: (request: NodeHttpRequest, response: NodeHttpResponse) => void
) => NodeHttpServer>(nodeCreateServer);
