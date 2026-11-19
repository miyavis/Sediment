import { Notice } from "obsidian";
import type { IncomingMessage, ServerResponse } from "http";
import type { SedimentPlugin } from "../main";

type HttpServer = import("http").Server;

/** 延迟加载 Node http，移动端不可用时优雅降级。 */
function getHttp(): typeof import("http") | null {
  try {
    return require("http") as typeof import("http");
  } catch (error) {
    return null;
  }
}

/** 127.0.0.1 上的轻量 HTTP API，供 MCP 桥接与本地脚本调用。 */
export class AgentServer {
  private server: HttpServer | null = null;
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
    const http = getHttp();
    if (!http) {
      new Notice("Agent API 需要桌面版 Obsidian（移动端无 Node http）");
      return;
    }

    const server = http.createServer((request, response) => {
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
      new Notice(`Agent API 已启动：http://127.0.0.1:${desired.port}`);
    } catch (error) {
      new Notice(`Agent API 启动失败（端口 ${desired.port}）：${String(error)}`);
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

  private json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(JSON.stringify(payload));
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) throw new Error("请求体过大（上限 1MB）");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, unknown>;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const headerToken = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const supplied = url.searchParams.get("token") ?? headerToken;
    const expected = this.plugin.store.settings.agentServerToken;
    if (!expected || supplied !== expected) {
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

      switch (`${request.method} ${url.pathname}`) {
        case "GET /health":
          this.json(response, 200, { ok: true, plugin: "sediment", version: "0.2.4" });
          return;
        case "GET /notes":
          this.json(response, 200, api.listNotes(str(query.get("folder")), num(query.get("limit"), 50)));
          return;
        case "GET /search":
          this.json(response, 200, await api.searchNotes(str(query.get("q")), num(query.get("limit"), 10)));
          return;
        case "GET /note":
          this.json(response, 200, await api.readNote(str(query.get("path"))));
          return;
        case "POST /note": {
          const mode = str(body.mode as string, "create") as "create" | "overwrite" | "append";
          this.json(response, 200, await api.writeNote(str(body.path as string), str(body.content as string), mode));
          return;
        }
        case "POST /memo": {
          const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
          this.json(response, 200, await api.addMemo(str(body.text as string), tags));
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
        case "GET /pomodoro":
          this.json(response, 200, api.getPomodoro());
          return;
        case "POST /pomodoro":
          this.json(response, 200, api.controlPomodoro(str(body.action as string, "toggle")));
          return;
        default:
          this.json(response, 404, { error: `未知接口：${request.method} ${url.pathname}` });
      }
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
