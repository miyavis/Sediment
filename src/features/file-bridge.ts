import { ApiError } from "../agent/api";
import {
  BRIDGE_MAX_IMPORTS_PER_SCAN,
  BRIDGE_MAX_PENDING,
  BRIDGE_POLL_MS,
  BRIDGE_PROPOSAL_MAX_BYTES,
  buildBridgeDecision,
  bridgePendingId,
  bridgeProposalIdFromPath,
  bridgeTextTooLarge,
  isBridgeProposalId,
  parseBridgeProposal,
  type BridgeDecisionRecord,
  type BridgeProposal,
  type BridgeRejectReason,
  type BridgeTool,
} from "../agent/bridge-schema";
import type { PendingWriteRecord } from "../types";
import { tf } from "../i18n";
import type SedimentPlugin from "../main";

interface BridgeAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  stat?(path: string): Promise<{ size: number } | null>;
}

function proposalPathOf(proposal: BridgeProposal): string {
  if (proposal.tool === "write_note") return proposal.args.path;
  if (proposal.tool === "patch_note") return proposal.args.input.path;
  return "";
}

function toolOfRecord(tool: string): BridgeTool | undefined {
  // 内部挂起名 "frontmatter" 实际走 patch_note 落盘：决策文件必须保留真实工具名。
  if (tool === "frontmatter") return "patch_note";
  return tool === "write_note" || tool === "patch_note" || tool === "add_knowledge" ? tool : undefined;
}

function mapImportError(error: unknown): { reason: BridgeRejectReason; message: string } {
  if (error instanceof ApiError) {
    const code = error.code.toLowerCase();
    const allowed: BridgeRejectReason[] = [
      "forbidden",
      "operation_denied",
      "not_found",
      "version_conflict",
      "ambiguous_match",
      "missing_anchor",
      "invalid_json",
    ];
    // ApiError.message 可能内嵌提案片段（如 NOT_FOUND 回显 find 正文）：决策只给代码。
    return {
      reason: allowed.includes(code as BridgeRejectReason) ? (code as BridgeRejectReason) : "import_failed",
      message: tf("文件桥导入失败：{code}", { code: error.code }),
    };
  }
  return { reason: "import_failed", message: error instanceof Error ? error.message : String(error) };
}

/**
 * 文件桥：轮询插件目录里的提案，导入待审队列，写回决策。
 * - 不使用 vault 事件（配置文件夹下没有事件），只走 adapter；
 * - 提案永远不自动落盘；
 * - 禁用后停止轮询，但已挂起项仍可正常审批。
 */
export class FileBridge {
  private timer: number | null = null;
  private scanning = false;
  private flushPromise: Promise<void> | null = null;
  /** 禁用后为 true：进行中的扫描要立刻停手，不能继续导入。 */
  private stopped = false;
  private failedIds = new Set<string>();
  private decisions = new Map<string, BridgeDecisionRecord>();
  private lastQueueFullLog = 0;
  private decisionFailureLogged = false;

  constructor(private plugin: SedimentPlugin) {}

  applySettings(): void {
    if (this.plugin.store.settings.fileBridgeEnabled) this.start();
    else this.stop();
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    void this.scanNow();
    this.timer = window.setInterval(() => void this.scanNow(), BRIDGE_POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.failedIds.clear();
  }

  /** 采纳/驳回后的决策写回；非文件桥记录直接忽略。 */
  notifyDecision(
    record: PendingWriteRecord,
    decision: "approved" | "rejected",
    reason: BridgeRejectReason
  ): void {
    if (record.source !== "bridge" || !record.proposalId) return;
    // 决策文件名只接受 schema 校验过的 id，避免异常 proposalId 拼出越界路径。
    if (!isBridgeProposalId(record.proposalId)) {
      this.plugin.store.logDiagnostic("security", "文件桥决策 id 非法，已忽略", record.proposalId);
      return;
    }
    this.decisions.set(
      record.proposalId,
      buildBridgeDecision({
        id: record.proposalId,
        pendingId: record.id,
        decision,
        reason,
        agent: record.agent,
        tool: toolOfRecord(record.tool),
        path: record.path,
      })
    );
    void this.flushNow();
  }

  /** 供测试与启动时立即处理；正常轮询也走这里。 */
  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const adapter = this.adapter();
      await this.ensureDirs(adapter);
      await this.flushNow();

      const pending = this.plugin.store.data.pendingWrites ?? [];
      if (pending.length >= BRIDGE_MAX_PENDING) {
        this.logQueueFull();
        return;
      }

      const [proposalList, decisionList] = await Promise.all([
        adapter.list(this.proposalsDir()).catch(() => ({ files: [], folders: [] })),
        adapter.list(this.decisionsDir()).catch(() => ({ files: [], folders: [] })),
      ]);
      const decided = new Set<string>();
      for (const file of decisionList.files) {
        const id = bridgeProposalIdFromPath(file);
        if (id) decided.add(id);
      }
      const candidates = proposalList.files
        .map(bridgeProposalIdFromPath)
        .filter((id): id is string => id !== null)
        .filter((id) => !decided.has(id) && !this.failedIds.has(id))
        .filter((id) => !pending.some((item) => item.id === bridgePendingId(id)))
        .sort();

      let imported = 0;
      for (const id of candidates) {
        if (this.stopped) break;
        if (imported >= BRIDGE_MAX_IMPORTS_PER_SCAN) break;
        if ((this.plugin.store.data.pendingWrites ?? []).length >= BRIDGE_MAX_PENDING) {
          this.logQueueFull();
          break;
        }
        const path = `${this.proposalsDir()}/${id}.json`;
        if (adapter.stat) {
          const stat = await adapter.stat(path).catch(() => null);
          if (stat && stat.size > BRIDGE_PROPOSAL_MAX_BYTES) {
            this.reject(id, "too_large", "提案超过 256 KB");
            continue;
          }
        }
        let text: string;
        try {
          text = await adapter.read(path);
        } catch {
          continue;
        }
        if (bridgeTextTooLarge(text)) {
          this.reject(id, "too_large", "提案超过 256 KB");
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          this.reject(id, "invalid_json", "提案不是合法 JSON");
          continue;
        }
        const parsed = parseBridgeProposal(id, raw);
        if (!parsed.ok) {
          this.reject(id, parsed.reason, parsed.message);
          continue;
        }
        // 导入前再查一次：扫描期间用户可能刚采纳/驳回同一条提案。
        if (this.decisions.has(id) || (await adapter.exists(`${this.decisionsDir()}/${id}.json`))) {
          continue;
        }
        // 读文件期间用户可能刚关闭文件桥；此时不再导入本条。
        if (this.stopped) break;
        try {
          await this.plugin.agentApi.importBridgeProposal(parsed.proposal);
          imported += 1;
          this.plugin.store.logDiagnostic(
            "storage",
            `文件桥已导入待审提案：${parsed.proposal.tool}`,
            id
          );
        } catch (error) {
          const mapped = mapImportError(error);
          this.reject(id, mapped.reason, mapped.message, parsed.proposal);
        }
      }
      // reject() 只排队决策；这里等决策真正写盘，探测结果当轮可见。
      await this.flushNow();
      if (imported > 0) this.plugin.refreshViews();
    } catch (error) {
      this.plugin.store.logDiagnostic(
        "storage",
        `文件桥轮询失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 把内存里的决策尽快写盘；失败保留到下次轮询。
   * 链式排队而非合并：轮询关闭时 notifyDecision 也要把新决策写出去。
   */
  async flushNow(): Promise<void> {
    const previous = this.flushPromise ?? Promise.resolve();
    const next = previous.then(() => this.flushDecisions()).catch(() => {});
    this.flushPromise = next;
    try {
      await next;
    } finally {
      if (this.flushPromise === next) this.flushPromise = null;
    }
  }

  private adapter(): BridgeAdapter {
    return this.plugin.app.vault.adapter as unknown as BridgeAdapter;
  }

  private bridgeRoot(): string {
    const manifest = this.plugin.manifest;
    const base = manifest.dir || `${this.plugin.app.vault.configDir}/plugins/${manifest.id}`;
    return `${base}/bridge`;
  }

  private proposalsDir(): string {
    return `${this.bridgeRoot()}/proposals`;
  }

  private decisionsDir(): string {
    return `${this.bridgeRoot()}/decisions`;
  }

  private async ensureDirs(adapter: BridgeAdapter): Promise<void> {
    for (const path of [this.bridgeRoot(), this.proposalsDir(), this.decisionsDir()]) {
      try {
        if (!(await adapter.exists(path))) await adapter.mkdir(path);
      } catch {
        // 并发创建或权限问题；后续 list/read 会给出真实结果。
      }
    }
  }

  private reject(
    id: string,
    reason: BridgeRejectReason,
    message?: string,
    proposal?: BridgeProposal
  ): void {
    this.failedIds.add(id);
    this.decisions.set(
      id,
      buildBridgeDecision({
        id,
        pendingId: bridgePendingId(id),
        decision: "rejected",
        reason,
        ...(proposal
          ? { agent: proposal.agent, tool: proposal.tool, path: proposalPathOf(proposal) }
          : {}),
        ...(message ? { message } : {}),
      })
    );
    this.plugin.store.logDiagnostic("security", `文件桥提案被拒收：${reason}`, id);
    void this.flushNow();
  }

  private async flushDecisions(): Promise<void> {
    if (this.decisions.size === 0) return;
    const adapter = this.adapter();
    try {
      await this.ensureDirs(adapter);
      for (const [id, body] of [...this.decisions]) {
        const path = `${this.decisionsDir()}/${id}.json`;
        try {
          if (await adapter.exists(path)) {
            this.decisions.delete(id);
            continue;
          }
          await this.writeAtomic(adapter, path, JSON.stringify(body, null, 2));
          this.decisions.delete(id);
        } catch {
          this.logDecisionFailureOnce();
          // 保留到下次轮询重试。
        }
      }
    } catch {
      this.logDecisionFailureOnce();
    }
  }

  private logDecisionFailureOnce(): void {
    if (this.decisionFailureLogged) return;
    this.decisionFailureLogged = true;
    this.plugin.store.logDiagnostic("storage", "文件桥决策写入失败，将在下次轮询重试");
  }

  private async writeAtomic(adapter: BridgeAdapter, path: string, text: string): Promise<void> {
    if (!adapter.rename) {
      await adapter.write(path, text);
      return;
    }
    const tmp = `${path}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await adapter.write(tmp, text);
      await adapter.rename(tmp, path);
    } catch (error) {
      if (await adapter.exists(path)) return;
      try {
        await adapter.write(path, text);
      } catch {
        throw error;
      }
      if (adapter.remove) {
        try {
          await adapter.remove(tmp);
        } catch {
          // 临时文件清理失败不影响决策。
        }
      }
    }
  }

  private logQueueFull(): void {
    const now = Date.now();
    if (now - this.lastQueueFullLog < 60_000) return;
    this.lastQueueFullLog = now;
    this.plugin.store.logDiagnostic("storage", "文件桥暂停导入：待审队列已满（100）");
  }
}
