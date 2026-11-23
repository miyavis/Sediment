import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeTimeline, findCallByPendingId, reviewDecisionOf } from "../../src/features/change-timeline";
import { buildAuditExport, DEFAULT_EXPORT_OPTIONS } from "../../src/features/export";
import { fakeConfirmPlugin } from "../helpers";

test("reviewDecisionOf：兼容旧字符串与带时间戳的新格式", () => {
  assert.equal(reviewDecisionOf("kept"), "kept");
  assert.equal(reviewDecisionOf({ decision: "reverted", time: "2026-01-01T00:00:00.000Z" }), "reverted");
  assert.equal(reviewDecisionOf(undefined), undefined);
});

test("buildChangeTimeline：合并调用/挂起/审批/快照，按时间倒序", () => {
  const ctx = fakeConfirmPlugin({ agentWorkMode: "confirm" }, { "notes/a.md": "old\n" });
  ctx.store.data.toolCalls.push({
    time: "2026-11-22T10:00:00.000Z", tool: "POST /note", agent: "qoder", path: "notes/a.md",
    pendingId: "pw-1", held: true,
  });
  ctx.store.data.pendingWrites.push({
    id: "pw-1", time: "2026-11-22T10:00:01.000Z", tool: "write_note", agent: "qoder",
    path: "notes/a.md", request: { kind: "write_note", args: { path: "notes/a.md", content: "new", mode: "overwrite" } },
    before: "old\n", beforeHash: "deadbeef", after: "new", expectAbsent: false,
  });
  ctx.store.data.snapshots.push({
    id: "snap-1", path: "notes/a.md", time: "2026-11-22T10:02:00.000Z", tool: "write_note", agent: "qoder",
  });
  ctx.store.data.reviewedChanges ??= {};
  ctx.store.data.reviewedChanges["2026-11-22T10:00:00.000Z|notes/a.md"] = {
    decision: "kept", time: "2026-11-22T10:01:30.000Z",
  };

  const events = buildChangeTimeline(ctx.store.data as never);
  assert.deepEqual(events.map((e) => e.kind), ["snapshot", "decision", "pending", "call"]);
  const pending = events.find((e) => e.kind === "pending");
  assert.equal(pending?.hash, "deadbeef");
  const decision = events.find((e) => e.kind === "decision");
  assert.equal(decision?.decision, "kept");
  assert.equal(decision?.snapshotId, "snap-1", "审批事件关联到同一路径的快照");
  assert.ok(findCallByPendingId(ctx.store.data.toolCalls, "pw-1"));
});

test("buildChangeTimeline：驳回的待审写入永久留痕（C1）", () => {
  const ctx = fakeConfirmPlugin();
  ctx.store.data.writeDecisions = [
    {
      id: "decision:pw-2:rejected",
      time: "2026-11-23T09:00:00.000Z",
      pendingId: "pw-2",
      decision: "rejected",
      tool: "write_note",
      agent: "opencode",
      path: "notes/x.md",
      reason: "user_rejected",
    },
  ];
  const events = buildChangeTimeline(ctx.store.data as never);
  const rejected = events.find((e) => e.kind === "decision" && e.status === "rejected");
  assert.ok(rejected, "驳回事件必须出现在时间线");
  assert.equal(rejected?.path, "notes/x.md");
  assert.equal(rejected?.pendingId, "pw-2");
  assert.match(rejected?.title ?? "", /驳回/);
});

test("buildChangeTimeline：limit/offset/agent/path/includeReads 口径（F15）", () => {
  const ctx = fakeConfirmPlugin();
  ctx.store.data.toolCalls = [
    { time: "2026-11-22T10:00:00.000Z", tool: "GET /stats", agent: "a", path: "x.md" },
    { time: "2026-11-22T11:00:00.000Z", tool: "POST /note", agent: "a", path: "notes/a.md" },
    { time: "2026-11-22T12:00:00.000Z", tool: "POST /note", agent: "b", path: "notes/b.md" },
  ];
  const all = buildChangeTimeline(ctx.store.data as never);
  assert.equal(all.some((e) => e.tool === "GET /stats"), false, "默认排除只读调用");
  const withReads = buildChangeTimeline(ctx.store.data as never, { includeReads: true });
  assert.equal(withReads.some((e) => e.tool === "GET /stats"), true);
  const byAgent = buildChangeTimeline(ctx.store.data as never, { agent: "b" });
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].path, "notes/b.md");
  const byPath = buildChangeTimeline(ctx.store.data as never, { path: "notes/a" });
  assert.equal(byPath.length, 1);
  const paged = buildChangeTimeline(ctx.store.data as never, { limit: 1, offset: 1 });
  assert.equal(paged.length, 1);
  assert.equal(paged[0].path, "notes/a.md", "offset=1 取时间倒序第 2 条");
});

test("buildAuditExport：JSON 默认哈希路径，CSV 为事件流", () => {
  const ctx = fakeConfirmPlugin();
  ctx.store.data.toolCalls.push({
    time: "2026-11-22T10:00:00.000Z", tool: "POST /note", agent: "qoder", path: "Sediment/knowledge/secret.md",
  });
  const json = buildAuditExport(ctx.store as never, DEFAULT_EXPORT_OPTIONS);
  assert.ok(json.includes('"kind": "audit-bundle"'));
  assert.ok(!json.includes("secret.md"), "默认导出不得包含路径原文");
  assert.ok(json.includes("path:"), "路径以短哈希代替");

  const csv = buildAuditExport(ctx.store as never, { ...DEFAULT_EXPORT_OPTIONS, format: "csv" });
  assert.match(csv, /^time,kind,agent,tool,path,title,decision,hash,snapshotId,pendingId,status/);
  assert.ok(csv.includes("qoder"));
});
