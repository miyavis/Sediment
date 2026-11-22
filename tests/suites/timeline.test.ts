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
