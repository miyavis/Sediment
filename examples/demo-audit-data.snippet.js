/**
 * 演示数据：在 Obsidian 开发者控制台（Ctrl+Shift+I）粘贴执行。
 * 作用：向当前运行的 Sediment store 注入一组审计事件，便于截图「变更时间线」。
 * 恢复：执行前数据已由维护者备份；截图后可删除这些 id 或恢复 data.json。
 */
(() => {
  const s = window.Sediment?.store;
  if (!s) throw new Error("未找到 Sediment store，请确认插件已启用");
  const t = (h, m) => `2026-11-22T${h}:${m}:00.000Z`;
  const paths = [
    "Sediment/knowledge/灵感/演示：产品定位草案.md",
    "Sediment/knowledge/方法/演示：发版检查清单.md",
    "Sediment/daily/2026-11-22.md",
  ];
  const calls = [
    { time: t("09","12"), tool: "POST /note", agent: "qoder", path: paths[0], pendingId: "demo-pw-1", held: true },
    { time: t("09","31"), tool: "POST /patch-note", agent: "opencode", path: paths[1] },
    { time: t("10","05"), tool: "POST /knowledge", agent: "cursor", path: paths[0] },
    { time: t("10","42"), tool: "POST /worklog", agent: "qoder", path: paths[2] },
    { time: t("11","18"), tool: "POST /note", agent: "opencode", path: paths[1] },
  ];
  s.data.toolCalls.unshift(...calls);
  s.data.pendingWrites.unshift({
    id: "demo-pw-1", time: t("09","12"), tool: "write_note", agent: "qoder",
    path: paths[0], request: { kind: "write_note", args: { path: paths[0], content: "演示内容", mode: "create" } },
    before: "", beforeHash: "4f1bb18c2a", expectAbsent: true, after: "演示内容",
  });
  s.data.snapshots.unshift(
    { id: "demo-snap-1", path: paths[1], time: t("09","35"), tool: "patch_note", agent: "opencode" },
    { id: "demo-snap-2", path: paths[0], time: t("10","10"), tool: "add_knowledge", agent: "cursor" }
  );
  s.data.reviewedChanges ??= {};
  s.data.reviewedChanges[t("09","31") + "|" + paths[1]] = { decision: "kept", time: t("09","36") };
  s.data.reviewedChanges[t("10","05") + "|" + paths[0]] = { decision: "reverted", time: t("10","11") };
  void s.save().then(() => {
    window.Sediment.plugin.refreshViews();
    console.log("demo audit data injected");
  });
})();
