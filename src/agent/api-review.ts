/** confirm 审核队列：挂起 / 采纳 / 驳回 / 文件桥提案 / 重放分发。
 *  以原型混入方式挂在 AgentApi 上，对外 API 不变；逻辑独立成文件便于审查。 */
import { TFile } from "obsidian";
import { t, tf } from "../i18n";
import { contentHash } from "../utils/hash";
import type { PendingWriteRecord } from "../types";
import { bridgePendingId, type BridgeProposal } from "./bridge-schema";
import { ApiError, type AgentApi, type AgentPendingResult, type KnowledgeInput, type WorkLogInput, type WriteMeta } from "./api";

export interface ReviewMethods {
  isConfirmMode(): boolean;
  holdForConfirm(tool: string, path: string, kind: string, args: Record<string, unknown>, before: string, after: string, meta?: WriteMeta): AgentPendingResult;
  listPendingWrites(limit?: number): Array<{ id: string; time: string; tool: string; agent: string; path: string }>;
  getPendingWrite(id: string): PendingWriteRecord | null;
  settlePendingCall(record: PendingWriteRecord, landed: boolean): void;
  assertPendingUnchanged(record: PendingWriteRecord): Promise<void>;
  approvePendingWrite(id: string): Promise<{ path: string }>;
  rejectPendingWrite(id: string): { ok: true; path: string };
  importBridgeProposal(proposal: BridgeProposal): Promise<{ pendingId: string; path: string }>;
  replayPending(request: PendingWriteRecord["request"], agent?: string): Promise<void>;
}

export const reviewMethods: ReviewMethods = {
  isConfirmMode(this: AgentApi): boolean {
    return this.plugin.store.settings.agentWorkMode === "confirm";
  },

  /** 把一次写入挂起为待审条目并返回给调用方；不落盘、不建目录、不写快照。 */
  holdForConfirm(
    this: AgentApi,
    tool: string,
    path: string,
    kind: string,
    args: Record<string, unknown>,
    before: string,
    after: string,
    meta: WriteMeta = {}
  ): AgentPendingResult {
    const id = meta.id ?? `pw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // 条目式写入（速记/工作日志/任务快照等）的 before 也为空串，不能当成「新建文件」。
    const ENTRY_KINDS = new Set([
      "memo", "task_snapshot", "task_complete", "delegate_task", "snapshot_tasks",
      "claim_agent_task", "complete_agent_task", "agent_task_claim", "agent_task_complete",
    ]);
    const expectAbsent = before === "" && !ENTRY_KINDS.has(kind);
    this.plugin.store.addPendingWrite({
      id,
      time: new Date().toISOString(),
      tool,
      agent: meta.agent || "agent",
      path,
      request: { kind, args },
      before,
      beforeHash: contentHash(before),
      expectAbsent,
      after,
      ...(meta.source === "bridge" && meta.proposalId
        ? { source: "bridge" as const, proposalId: meta.proposalId }
        : {}),
    });
    // 文件桥导入不经过 HTTP 调用记录；仅把当前请求的调用标记为挂起，防止重复计数。
    if (meta.source !== "bridge") {
      this.plugin.store.markToolCallHeld(meta.call ?? null, id);
    }
    const message = tf("confirm 模式下写入已挂起待审：{path}", { path });
    this.plugin.store.logDiagnostic("storage", message, `${id} · ${tool}`);
    return { pending: true, pendingId: id, path, message };
  },

  /** 待审列表（不含大段预览内容，供 Agent / UI 展示）。 */
  listPendingWrites(this: AgentApi, limit = 50) {
    return (this.plugin.store.data.pendingWrites ?? [])
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(({ id, time, tool, agent, path }) => ({ id, time, tool, agent, path }));
  },

  getPendingWrite(this: AgentApi, id: string): PendingWriteRecord | null {
    return (this.plugin.store.data.pendingWrites ?? []).find((item) => item.id === id) ?? null;
  },

  /** 结算待审写入对应的调用流水：采纳后转入变更审查；驳回则整条移除。 */
  settlePendingCall(this: AgentApi, record: PendingWriteRecord, landed: boolean): void {
    if (!landed) {
      this.plugin.store.dropPendingToolCall(record.id);
      return;
    }
    if (this.plugin.store.releaseToolCall(record.id)) return;
    this.plugin.store.logToolCall(
      {
        time: new Date().toISOString(),
        tool: `POST ${record.tool}`,
        agent: record.agent,
        path: record.path,
      },
      false
    );
  },

  /** 采纳前复验：删除/移动 → STALE_PENDING；内容被改 → CONTENT_CHANGED。 */
  async assertPendingUnchanged(this: AgentApi, record: PendingWriteRecord): Promise<void> {
    const file = this.vault.getAbstractFileByPath(record.path);
    if (record.expectAbsent) {
      if (file instanceof TFile) {
        throw new ApiError(
          "CONTENT_CHANGED",
          tf("待审目标在挂起后被创建，请驳回后让 Agent 重发：{path}", { path: record.path }),
          409
        );
      }
      return;
    }
    if (record.before === "") return;
    if (!(file instanceof TFile)) {
      throw new ApiError(
        "STALE_PENDING",
        tf("待审写入已失效（目标被删除或移动）：{path}，请驳回后让 Agent 重发", { path: record.path }),
        409
      );
    }
    if (record.beforeHash) {
      const current = await this.vault.read(file);
      if (contentHash(current) !== record.beforeHash) {
        throw new ApiError(
          "CONTENT_CHANGED",
          tf("待审目标内容在挂起后被修改，请驳回后让 Agent 重发：{path}", { path: record.path }),
          409
        );
      }
    }
  },

  /** 采纳：按挂起时保存的原请求重放落盘函数；同 id 并发采纳原子占位。 */
  async approvePendingWrite(this: AgentApi, id: string): Promise<{ path: string }> {
    if (this.approving.has(id)) {
      throw new ApiError("PENDING_IN_FLIGHT", t("该待审写入正在采纳中，请稍候"), 409);
    }
    this.approving.add(id);
    try {
      const record = this.getPendingWrite(id);
      if (!record) throw new ApiError("NOT_FOUND", tf("待审写入不存在：{id}", { id }), 404);
      if (record.stale) {
        throw new ApiError(
          "STALE_PENDING",
          tf("待审写入已失效（目标被删除或移动）：{path}，请驳回后让 Agent 重发", { path: record.path }),
          409
        );
      }
      await this.assertPendingUnchanged(record);
      await this.replayPending(record.request, record.agent);
      this.plugin.store.removePendingWrite(id);
      this.settlePendingCall(record, true);
      if (record.source === "bridge") {
        this.bridgeSink?.notifyDecision(record, "approved", "user_approved");
      }
      const message = tf("待审写入已采纳并落盘：{path}", { path: record.path });
      this.plugin.store.logDiagnostic("storage", message, id);
      return { path: record.path };
    } finally {
      this.approving.delete(id);
    }
  },

  /** 驳回：丢弃挂起请求（不落盘），并记安全诊断。 */
  rejectPendingWrite(this: AgentApi, id: string): { ok: true; path: string } {
    const removed = this.plugin.store.removePendingWrite(id);
    if (!removed) throw new ApiError("NOT_FOUND", tf("待审写入不存在：{id}", { id }), 404);
    this.settlePendingCall(removed, false);
    if (removed.source === "bridge") {
      this.bridgeSink?.notifyDecision(removed, "rejected", removed.stale ? "stale" : "user_rejected");
    }
    const message = tf("待审写入已驳回并丢弃：{path}", { path: removed.path });
    this.plugin.store.logDiagnostic("security", message, `${removed.id} · ${removed.tool}`);
    return { ok: true, path: removed.path };
  },

  /** 文件桥导入：校验 + 门禁 + 预览 + 无条件挂起；绝不直接落盘。 */
  async importBridgeProposal(this: AgentApi, proposal: BridgeProposal): Promise<{ pendingId: string; path: string }> {
    if (!proposal.id) throw new ApiError("INVALID_PROPOSAL", t("文件桥提案缺少 id"), 400);
    const meta: WriteMeta = {
      id: bridgePendingId(proposal.id),
      hold: true,
      agent: proposal.agent,
      source: "bridge",
      proposalId: proposal.id,
    };
    let result: { path: string; pending?: true; pendingId?: string } | undefined;
    switch (proposal.tool) {
      case "write_note":
        result = await this.writeNote(
          proposal.args.path,
          proposal.args.content,
          proposal.args.mode,
          false,
          meta
        );
        break;
      case "patch_note":
        result = await this.patchNote(proposal.args.input, false, meta);
        break;
      case "add_knowledge":
        result = await this.addKnowledge(
          { ...proposal.args.input, agent: proposal.agent },
          false,
          meta
        );
        break;
    }
    if (!result?.pending || !result.pendingId) {
      throw new ApiError("INVALID_PROPOSAL", tf("文件桥提案未挂起：{id}", { id: proposal.id }), 400);
    }
    return { pendingId: result.pendingId, path: result.path };
  },

  /** 采纳时的重放分发：各 kind 与写方法一一对应。 */
  async replayPending(this: AgentApi, request: PendingWriteRecord["request"], agent = ""): Promise<void> {
    const meta: WriteMeta = agent ? { agent, replay: true } : { replay: true };
    const args = request.args;
    const str = (value: unknown): string =>
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : "";
    const requireRecord = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ApiError("INVALID_PENDING", t("待审写入参数损坏，请驳回后让 Agent 重发"), 400);
      }
      return value as Record<string, unknown>;
    };
    switch (request.kind) {
      case "write_note":
        await this.writeNote(
          str(args.path),
          str(args.content),
          (str(args.mode) || "create") as "create" | "overwrite" | "append",
          true,
          meta
        );
        return;
      case "patch_note":
        await this.patchNote(requireRecord(args.input) as Parameters<AgentApi["patchNote"]>[0], true, meta);
        return;
      case "frontmatter":
        await this.updateFrontmatter(
          str(args.path),
          requireRecord(args.updates ?? {}),
          args.ifMatch ? str(args.ifMatch) : undefined,
          true,
          meta
        );
        return;
      case "knowledge":
        await this.addKnowledge(requireRecord(args.input) as unknown as KnowledgeInput, true, meta);
        return;
      case "memo":
        await this.addMemo(
          str(args.text),
          Array.isArray(args.tags) ? args.tags.map(String) : [],
          args.sourcePath ? str(args.sourcePath) : undefined,
          typeof args.sourceLine === "number" ? args.sourceLine : undefined,
          true,
          meta
        );
        return;
      case "worklog":
        await this.recordWorkLog(requireRecord(args.input) as unknown as WorkLogInput, true, meta);
        return;
      case "task_complete":
        await this.completeTask(str(args.path), Number(args.line), true, meta);
        return;
      case "task_snapshot":
        await this.snapshotTasks(true, meta);
        return;
      case "claim_agent_task":
        await this.claimAgentTask(str(args.id), false, meta);
        return;
      case "complete_agent_task":
        await this.completeAgentTask(str(args.id), args.resultPath ? str(args.resultPath) : undefined, false, meta);
        return;
      default:
        throw new ApiError("INVALID_PENDING", tf("未知的待审写入类型：{kind}", { kind: request.kind }), 400);
    }
  },
};
