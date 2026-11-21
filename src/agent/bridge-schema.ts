import type { KnowledgeInput } from "./api";

export const BRIDGE_VERSION = 1;
export const BRIDGE_PROPOSAL_MAX_BYTES = 256 * 1024;
export const BRIDGE_MAX_IMPORTS_PER_SCAN = 10;
export const BRIDGE_MAX_PENDING = 100;
export const BRIDGE_POLL_MS = 5000;
export const BRIDGE_MAX_ID_LENGTH = 64;
export const BRIDGE_MAX_AGENT_LENGTH = 64;
export const BRIDGE_MAX_NOTE_LENGTH = 2000;
export const BRIDGE_MAX_PATH_LENGTH = 1024;
export const BRIDGE_MAX_FIELD_LENGTH = 200;
export const BRIDGE_MAX_LIST_ITEMS = 50;

export type BridgeTool = "write_note" | "patch_note" | "add_knowledge";

export type BridgeRejectReason =
  | "invalid_json"
  | "invalid_schema"
  | "unsupported_version"
  | "too_large"
  | "invalid_id"
  | "forbidden"
  | "operation_denied"
  | "not_found"
  | "version_conflict"
  | "ambiguous_match"
  | "missing_anchor"
  | "import_failed"
  | "queue_full"
  | "user_approved"
  | "user_rejected"
  | "stale";

export interface BridgePatchNoteInput {
  path: string;
  heading?: string;
  find?: string;
  content: string;
  mode?: "replace" | "append" | "prepend";
  operation?: "append_under_heading" | "prepend_under_heading" | "replace_block" | "update_frontmatter";
  index?: number;
  ifMatch?: string;
  expectedMtime?: number;
}

export interface BridgeWriteNoteProposal {
  id: string;
  agent: string;
  tool: "write_note";
  note?: string;
  args: { path: string; content: string; mode: "create" | "overwrite" | "append" };
}

export interface BridgePatchNoteProposal {
  id: string;
  agent: string;
  tool: "patch_note";
  note?: string;
  args: { input: BridgePatchNoteInput };
}

export interface BridgeKnowledgeProposal {
  id: string;
  agent: string;
  tool: "add_knowledge";
  note?: string;
  args: { input: KnowledgeInput };
}

export type BridgeProposal = BridgeWriteNoteProposal | BridgePatchNoteProposal | BridgeKnowledgeProposal;

export type BridgeParseResult =
  | { ok: true; proposal: BridgeProposal }
  | { ok: false; reason: BridgeRejectReason; message: string };

export interface BridgeDecisionRecord {
  version: 1;
  id: string;
  pendingId: string;
  agent?: string;
  tool?: BridgeTool;
  path?: string;
  decision: "approved" | "rejected";
  reason: BridgeRejectReason;
  message?: string;
  time: string;
}

function fail(reason: BridgeRejectReason, message: string): BridgeParseResult {
  return { ok: false, reason, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function optionalString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) return null;
  return value;
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > BRIDGE_MAX_LIST_ITEMS) return null;
  if (!value.every((item) => typeof item === "string" && item.length <= BRIDGE_MAX_FIELD_LENGTH)) return null;
  return value as string[];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
  if (value === undefined) return undefined;
  return allowed.includes(value as T) ? (value as T) : null;
}

/** 提案 id 即文件名；限定字符集，避免路径穿越与大小写/空格歧义。 */
export function isBridgeProposalId(value: string): boolean {
  return value.length >= 1 && value.length <= BRIDGE_MAX_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** 待审记录 id；与 MCP 的 pw-* 隔离。 */
export function bridgePendingId(id: string): string {
  return `bridge-${id}`;
}

/** 从 adapter.list 返回的完整路径中取提案 id；非 .json 或非法 id 返回 null。 */
export function bridgeProposalIdFromPath(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (!name.toLowerCase().endsWith(".json")) return null;
  const id = name.slice(0, -5);
  return isBridgeProposalId(id) ? id : null;
}

/** 按 UTF-8 字节数判断提案是否超限。 */
export function bridgeTextTooLarge(text: string): boolean {
  return new TextEncoder().encode(text).length > BRIDGE_PROPOSAL_MAX_BYTES;
}

/** 规范化来源 Agent 名；空、非字符串或超长返回 null。 */
export function normalizeBridgeAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > BRIDGE_MAX_AGENT_LENGTH) return null;
  const cleaned = trimmed.replace(/[\u0000-\u001f\u007f:#]/g, "-");
  return cleaned || null;
}

export function buildBridgeDecision(input: {
  id: string;
  pendingId: string;
  decision: "approved" | "rejected";
  reason: BridgeRejectReason;
  agent?: string;
  tool?: BridgeTool;
  path?: string;
  message?: string;
}): BridgeDecisionRecord {
  return {
    version: BRIDGE_VERSION,
    id: input.id,
    pendingId: input.pendingId,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.path ? { path: input.path } : {}),
    decision: input.decision,
    reason: input.reason,
    ...(input.message ? { message: input.message.slice(0, 500) } : {}),
    time: new Date().toISOString(),
  };
}

/** 解析并规范化一份提案；只读取白名单字段，未知字段丢弃。 */
export function parseBridgeProposal(id: string, raw: unknown): BridgeParseResult {
  if (!isBridgeProposalId(id)) return fail("invalid_id", "提案 id 非法（1–64 位字母数字或 ._-，且以字母数字开头）");
  if (!isRecord(raw)) return fail("invalid_schema", "提案必须是 JSON 对象");
  if (raw.id !== undefined && raw.id !== id) return fail("invalid_schema", "提案 id 与文件名不一致");
  if (raw.version !== undefined && raw.version !== BRIDGE_VERSION) {
    return fail("unsupported_version", `不支持的提案版本：${String(raw.version)}`);
  }
  const agent = normalizeBridgeAgent(raw.agent);
  if (!agent) return fail("invalid_schema", "agent 必须是非空字符串（≤64 字符）");
  const note = typeof raw.note === "string" ? raw.note.slice(0, BRIDGE_MAX_NOTE_LENGTH) : undefined;
  const tool = raw.tool;
  if (tool !== "write_note" && tool !== "patch_note" && tool !== "add_knowledge") {
    return fail("invalid_schema", "tool 只支持 write_note / patch_note / add_knowledge");
  }
  const args = raw.args;
  if (!isRecord(args)) return fail("invalid_schema", "args 必须是对象");

  if (tool === "write_note") {
    const path = requiredString(args.path, BRIDGE_MAX_PATH_LENGTH);
    if (!path) return fail("invalid_schema", "write_note.path 必须是非空字符串（≤1024 字符）");
    if (typeof args.content !== "string") return fail("invalid_schema", "write_note.content 必须是字符串");
    const mode = oneOf(args.mode, ["create", "overwrite", "append"] as const);
    if (mode === null) return fail("invalid_schema", "write_note.mode 只能是 create / overwrite / append");
    return {
      ok: true,
      proposal: {
        id,
        agent,
        tool: "write_note",
        ...(note ? { note } : {}),
        args: { path, content: args.content, mode: mode ?? "create" },
      },
    };
  }

  if (tool === "patch_note") {
    const inputRaw = args.input;
    if (!isRecord(inputRaw)) return fail("invalid_schema", "patch_note.args.input 必须是对象");
    const path = requiredString(inputRaw.path, BRIDGE_MAX_PATH_LENGTH);
    if (!path) return fail("invalid_schema", "patch_note.path 必须是非空字符串（≤1024 字符）");
    if (typeof inputRaw.content !== "string") return fail("invalid_schema", "patch_note.content 必须是字符串");
    if (inputRaw.dryRun === true) {
      return fail("invalid_schema", "文件桥不接受 dryRun；提案必须进入待审队列");
    }
    const heading = optionalString(inputRaw.heading, BRIDGE_MAX_FIELD_LENGTH);
    if (heading === null) return fail("invalid_schema", "patch_note.heading 必须是 ≤200 字符的字符串");
    const find = optionalString(inputRaw.find, BRIDGE_MAX_FIELD_LENGTH);
    if (find === null) return fail("invalid_schema", "patch_note.find 必须是 ≤200 字符的字符串");
    const mode = oneOf(inputRaw.mode, ["replace", "append", "prepend"] as const);
    if (mode === null) return fail("invalid_schema", "patch_note.mode 只能是 replace / append / prepend");
    const operation = oneOf(inputRaw.operation, [
      "append_under_heading",
      "prepend_under_heading",
      "replace_block",
      "update_frontmatter",
    ] as const);
    if (operation === null) return fail("invalid_schema", "patch_note.operation 非法");
    if (operation !== "update_frontmatter" && !heading && !find) {
      return fail("invalid_schema", "patch_note 需要 heading 或 find");
    }
    const index = inputRaw.index;
    if (
      index !== undefined &&
      (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 10000)
    ) {
      return fail("invalid_schema", "patch_note.index 必须是 0–10000 的整数");
    }
    const ifMatch = optionalString(inputRaw.ifMatch, BRIDGE_MAX_FIELD_LENGTH);
    if (ifMatch === null) return fail("invalid_schema", "patch_note.ifMatch 必须是 ≤200 字符的字符串");
    const expectedMtime = inputRaw.expectedMtime;
    if (
      expectedMtime !== undefined &&
      (typeof expectedMtime !== "number" || !Number.isFinite(expectedMtime) || expectedMtime <= 0)
    ) {
      return fail("invalid_schema", "patch_note.expectedMtime 必须是有限正数");
    }
    const input: BridgePatchNoteInput = { path, content: inputRaw.content };
    if (heading !== undefined) input.heading = heading;
    if (find !== undefined) input.find = find;
    if (mode !== undefined) input.mode = mode;
    if (operation !== undefined) input.operation = operation;
    if (index !== undefined) input.index = index as number;
    if (ifMatch !== undefined) input.ifMatch = ifMatch;
    if (expectedMtime !== undefined) input.expectedMtime = expectedMtime as number;
    return {
      ok: true,
      proposal: { id, agent, tool: "patch_note", ...(note ? { note } : {}), args: { input } },
    };
  }

  const inputRaw = args.input;
  if (!isRecord(inputRaw)) return fail("invalid_schema", "add_knowledge.args.input 必须是对象");
  const title = requiredString(inputRaw.title, BRIDGE_MAX_FIELD_LENGTH);
  if (!title || !title.trim()) return fail("invalid_schema", "add_knowledge.title 必须是非空字符串（≤200 字符）");
  if (typeof inputRaw.content !== "string") return fail("invalid_schema", "add_knowledge.content 必须是字符串");
  const tags = stringList(inputRaw.tags);
  if (tags === null) return fail("invalid_schema", "add_knowledge.tags 必须是最多 50 个短字符串");
  const links = stringList(inputRaw.links);
  if (links === null) return fail("invalid_schema", "add_knowledge.links 必须是最多 50 个短字符串");
  const category = optionalString(inputRaw.category, BRIDGE_MAX_FIELD_LENGTH);
  if (category === null) return fail("invalid_schema", "add_knowledge.category 必须是 ≤200 字符的字符串");
  const folder = optionalString(inputRaw.folder, BRIDGE_MAX_FIELD_LENGTH);
  if (folder === null) return fail("invalid_schema", "add_knowledge.folder 必须是 ≤200 字符的字符串");
  const source = optionalString(inputRaw.source, BRIDGE_MAX_FIELD_LENGTH);
  if (source === null) return fail("invalid_schema", "add_knowledge.source 必须是 ≤200 字符的字符串");
  const inputAgent = optionalString(inputRaw.agent, BRIDGE_MAX_FIELD_LENGTH);
  if (inputAgent === null) return fail("invalid_schema", "add_knowledge.agent 必须是 ≤200 字符的字符串");
  const input: KnowledgeInput = { title: title.trim(), content: inputRaw.content };
  if (tags.length) input.tags = tags;
  if (links.length) input.links = links;
  if (category !== undefined) input.category = category;
  if (folder !== undefined) input.folder = folder;
  if (source !== undefined) input.source = source;
  if (inputAgent !== undefined) input.agent = inputAgent;
  return {
    ok: true,
    proposal: { id, agent, tool: "add_knowledge", ...(note ? { note } : {}), args: { input } },
  };
}
