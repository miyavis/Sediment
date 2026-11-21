import { Notice } from "obsidian";
import type { SedimentPlugin } from "../main";
import {
  concatBytes,
  constantTimeEqual,
  createHttpServer,
  decodeUtf8,
  sha256Digest,
  type NodeHttpRequest,
  type NodeHttpResponse,
  type NodeHttpServer,
} from "../utils/node";
import { AGENT_API_VERSION, ApiError } from "./api";
import { redactAuditPath } from "./security";
import { t, tf } from "../i18n";
import { logError } from "../utils/log-error";

/**
 * 恒定时间令牌比较：两侧先各自做 SHA-256 摘要（定长，避免长度不等抛异常
 * 与长度侧信道），再用 timingSafeEqual 比较。
 */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = sha256Digest(String(supplied));
  const b = sha256Digest(String(expected));
  return constantTimeEqual(a, b);
}

/** 127.0.0.1 上的轻量 HTTP API，供 MCP 桥接与本地脚本调用。 */
export class AgentServer {
  private server: NodeHttpServer | null = null;
  private running: { enabled: boolean; port: number; token: string } | null = null;

  constructor(private plugin: SedimentPlugin) {}

  async applySettings(): Promise<void> {
    const settings = this.plugin.store.settings;
    const desired = {
      enabled: settings.agentServerEnabled,
      port: settings.agentServerPort,
      token: settings.agentServerToken,
    };
    const unchanged =
      this.running !== null &&
      this.running.enabled === desired.enabled &&
      this.running.port === desired.port &&
      this.running.token === desired.token;

    if (unchanged) return;
    await this.stop();

    if (!desired.enabled) return;

    const server = createHttpServer((request, response) => {
      void this.handle(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(desired.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.server = server;
      this.running = desired;
      new Notice(tf("Agent API 已启动：http://127.0.0.1:{port}", { port: desired.port }));
    } catch (error) {
      logError(this.plugin.store, "Agent API 启动失败", error);
      new Notice(tf("Agent API 启动失败（端口 {port}）：{error}", { port: desired.port, error: String(error) }));
      this.running = null;
      this.server = null;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.running = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private json(response: NodeHttpResponse, status: number, payload: unknown): void {
    // 仅本机回环使用，不开放跨域，避免网页脚本借令牌读写知识库。
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(payload));
  }

  private async readBody(request: NodeHttpRequest): Promise<Record<string, unknown>> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let oversized = false;
    // 注意：不能在 for await 内直接 throw——异步迭代器 return() 会销毁请求流，
    // 413 响应将随连接一起被重置。超限后停止缓冲但继续排空上传，再抛错。
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        oversized = true;
        chunks.length = 0;
        continue;
      }
      if (!oversized) chunks.push(chunk);
    }
    if (oversized) throw new ApiError("PAYLOAD_TOO_LARGE", t("请求体过大（上限 1MB）"), 413);
    if (chunks.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeUtf8(concatBytes(chunks)));
    } catch {
      throw new ApiError("INVALID_JSON", "请求体必须是合法的 JSON 对象", 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("INVALID_JSON", "请求体必须是 JSON 对象", 400);
    }
    return parsed as Record<string, unknown>;
  }

  private async handle(request: NodeHttpRequest, response: NodeHttpResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      this.json(response, 400, { error: t("非法的请求 URL"), code: "INVALID_URL" });
      return;
    }
    // 令牌只走 Authorization 头：?token= 查询串会落入日志/代理缓存，已移除支持。
    const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expected = this.plugin.store.settings.agentServerToken;
    if (!expected || !tokensMatch(supplied, expected)) {
      this.plugin.store.logDiagnostic(
        "security",
        "本地 API 鉴权失败",
        `source=${request.socket.remoteAddress ?? "unknown"} path=${redactAuditPath(url.pathname)}`
      );
      this.json(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      const api = this.plugin.agentApi;
      const query = url.searchParams;
      const body = request.method === "POST" ? await this.readBody(request) : {};
      const str = (value: string | null, fallback = ""): string => value ?? fallback;
      const num = (value: string | null, fallback: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };
      const agent = str(query.get("agent"), "") || String(request.headers["x-agent"] ?? "");
      const loggedPath =
        (typeof body.path === "string" ? body.path : "") || str(query.get("path"), "");
      api.logToolCall(`${request.method} ${url.pathname}`, agent, redactAuditPath(loggedPath));
      api.setCallContext(`${request.method} ${url.pathname}`, agent);

      switch (`${request.method} ${url.pathname}`) {
        case "GET /health":
          this.json(response, 200, { ok: true, plugin: "sediment", version: this.plugin.manifest.version, agentApiVersion: AGENT_API_VERSION });
          return;
        case "GET /notes":
          this.json(response, 200, api.listNotes(str(query.get("folder")), num(query.get("limit"), 50)));
          return;
        case "GET /search":
          this.json(response, 200, await api.searchNotes(str(query.get("q")), num(query.get("limit"), 10)));
          return;
        case "GET /semantic-search":
          this.json(response, 200, await api.semanticSearch(str(query.get("q")), num(query.get("limit"), 10)));
          return;
        case "GET /note":
          this.json(response, 200, await api.readNote(str(query.get("path"))));
          return;
        case "POST /note": {
          const rawMode = str(body.mode as string, "create");
          if (rawMode !== "create" && rawMode !== "overwrite" && rawMode !== "append") {
            this.json(response, 400, { error: "mode 必须是 create、overwrite 或 append", code: "INVALID_MODE" });
            return;
          }
          const mode = rawMode;
          this.json(response, 200, await api.writeNote(str(body.path as string), str(body.content as string), mode));
          return;
        }
        case "POST /memo": {
          const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
          this.json(
            response,
            200,
            await api.addMemo(
              str(body.text as string),
              tags,
              str(body.sourcePath as string) || undefined,
              typeof body.sourceLine === "number" ? body.sourceLine : undefined
            )
          );
          return;
        }
        case "GET /stats":
          this.json(response, 200, api.getStats(num(query.get("days"), 30)));
          return;
        case "GET /today":
          this.json(response, 200, api.getToday());
          return;
        case "GET /memos":
          this.json(response, 200, api.getMemos(num(query.get("limit"), 20)));
          return;
        case "GET /backlog":
          this.json(response, 200, api.getBacklog());
          return;
        case "GET /review":
          this.json(response, 200, api.generateWeeklyReview(str(query.get("date")) || undefined));
          return;
        case "POST /worklog": {
          const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
          const files = Array.isArray(body.files) ? (body.files as unknown[]).map(String) : [];
          this.json(
            response,
            200,
            await api.recordWorkLog({
              agent: str(body.agent as string),
              task: str(body.task as string),
              summary: str(body.summary as string),
              decisions: str(body.decisions as string),
              learnings: str(body.learnings as string),
              openQuestions: str(body.openQuestions as string),
              files,
              tags,
            })
          );
          return;
        }
        case "POST /knowledge": {
          const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
          const links = Array.isArray(body.links) ? (body.links as unknown[]).map(String) : [];
          this.json(
            response,
            200,
            await api.addKnowledge({
              title: str(body.title as string),
              content: str(body.content as string),
              category: str(body.category as string),
              folder: str(body.folder as string),
              agent: str(body.agent as string),
              source: str(body.source as string),
              tags,
              links,
            })
          );
          return;
        }
        case "GET /context":
          this.json(response, 200, api.getDailyContext(num(query.get("days"), 7)));
          return;
        case "GET /worklogs":
          this.json(response, 200, api.listWorkLogs(num(query.get("days"), 7)));
          return;
        case "GET /categories":
          this.json(response, 200, api.getCategories());
          return;
        case "GET /active-context":
          this.json(response, 200, api.getActiveContext());
          return;
        case "GET /note-metadata":
          this.json(response, 200, await api.getNoteMetadata(str(query.get("path"))));
          return;
        case "GET /graph": {
          const types = str(query.get("types"), "outgoing,backlinks,tags")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          this.json(response, 200, api.getGraphNeighbors(str(query.get("path")), types));
          return;
        }
        case "GET /activity":
          this.json(response, 200, api.getToolActivity());
          return;
        case "GET /tasks":
          this.json(response, 200, await api.listTasks(str(query.get("scope"), "all")));
          return;
        case "POST /tasks/complete":
          this.json(response, 200, await api.completeTask(str(body.path as string), Number(body.line)));
          return;
        case "POST /tasks/delegate":
          this.json(response, 200, await api.delegateTask(str(body.path as string), Number(body.line)));
          return;
        case "POST /tasks/snapshot":
          this.json(response, 200, await api.snapshotTasks());
          return;
        case "POST /patch-note":
          this.json(
            response,
            200,
            await api.patchNote({
              path: str(body.path as string),
              heading: str(body.heading as string) || undefined,
              find: str(body.find as string) || undefined,
              content: str(body.content as string),
              mode: str(body.mode as string, "replace") as "replace" | "append" | "prepend",
              operation: str(body.operation as string) as
                | "append_under_heading"
                | "prepend_under_heading"
                | "replace_block"
                | "update_frontmatter"
                | undefined,
              index: typeof body.index === "number" ? body.index : undefined,
              ifMatch: str(body.ifMatch as string) || undefined,
              expectedMtime: typeof body.expectedMtime === "number" ? body.expectedMtime : undefined,
              dryRun: body.dryRun === true,
            })
          );
          return;
        case "POST /frontmatter":
          this.json(
            response,
            200,
            await api.updateFrontmatter(
              str(body.path as string),
              (body.updates ?? {}) as Record<string, unknown>,
              str(body.ifMatch as string) || undefined
            )
          );
          return;
        case "POST /agent-task/claim":
          this.json(response, 200, await api.claimAgentTask(str(body.id as string)));
          return;
        case "POST /agent-task/complete":
          this.json(
            response,
            200,
            await api.completeAgentTask(str(body.id as string), str(body.resultPath as string) || undefined)
          );
          return;
        case "GET /pomodoro":
          this.json(response, 200, api.getPomodoro());
          return;
        case "POST /pomodoro":
          this.json(response, 200, api.controlPomodoro(str(body.action as string, "toggle")));
          return;
        case "GET /agent/audit":
          this.json(response, 200, api.getAgentChanges(num(query.get("limit"), 20)));
          return;
        case "POST /agent/revert":
          this.json(response, 200, await api.revertAgentChange(str(body.snapshotId as string)));
          return;
        default:
          this.json(response, 404, { error: `未知接口：${request.method} ${url.pathname}` });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        this.json(response, error.status, { error: error.message, code: error.code });
        return;
      }
      logError(this.plugin.store, "本地 API 请求处理失败", error);
      this.json(response, 500, { error: sanitizeServerError(error), code: "INTERNAL" });
    }
  }
}

/** 已知可安全回显的业务错误前缀；其余 500 消息一律脱敏，避免泄露内部路径/堆栈。 */
const SAFE_ERROR_PREFIXES = [
  "笔记已存在：",
  "笔记不存在：",
  "版本冲突：",
  "找不到待办：",
  "速记不存在：",
  "访问被拒绝：",
  "frontmatter 未闭合",
];

/** 500 响应消息白名单：只透传已知业务错误文案，其余统一为通用提示。 */
export function sanitizeServerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    /^速记 \S+ 不是待办任务$/.test(message)
  ) {
    return message;
  }
  return t("内部错误，详情见插件诊断日志");
}
