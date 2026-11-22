/** 在 Obsidian 开发者控制台粘贴执行，清除演示审计数据（不碰真实记录）。 */
(() => {
  const s = window.Sediment?.store;
  if (!s) throw new Error("未找到 Sediment store");
  const demoIds = new Set(["demo-pw-1", "demo-snap-1", "demo-snap-2"]);
  const demoTimes = new Set([
    "2026-11-22T09:12:00.000Z", "2026-11-22T09:31:00.000Z", "2026-11-22T10:05:00.000Z",
    "2026-11-22T10:42:00.000Z", "2026-11-22T11:18:00.000Z",
  ]);
  // 按精确时间删除全部演示调用，不再依赖路径是否含「演示」（worklog 那条路径不含）。
  s.data.toolCalls = (s.data.toolCalls || []).filter(
    (c) => c.pendingId !== "demo-pw-1" && !demoTimes.has(c.time)
  );
  s.data.pendingWrites = (s.data.pendingWrites || []).filter((p) => !demoIds.has(p.id));
  s.data.snapshots = (s.data.snapshots || []).filter((x) => !demoIds.has(x.id));
  s.data.reviewedChanges = Object.fromEntries(
    Object.entries(s.data.reviewedChanges || {}).filter(
      ([key]) => !/演示/.test(key) && ![...demoTimes].some((t) => key.startsWith(t))
    )
  );
  void s.save().then(() => {
    window.Sediment.plugin.refreshViews();
    console.log("demo audit data cleared");
  });
})();
