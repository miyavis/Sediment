// 可重复的纯函数基准：统计贡献分计算在 1k/10k/100k 天样本上的耗时与堆内存。
// 不依赖真实 vault，也不上传任何数据；结果用于发现明显退化，而非绝对性能指标。
import { build } from "esbuild";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, "tests", ".bench.bundle.cjs");

await build({
  entryPoints: [path.join(root, "src", "types.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["obsidian"],
  logLevel: "warning",
});

const require = Module.createRequire(import.meta.url);
const { computeContribution, createEmptyDay, DEFAULT_SETTINGS } = require(outfile);

const settings = { ...DEFAULT_SETTINGS, contributionDailyCap: 120 };
const sample = (index) => ({
  ...createEmptyDay(),
  wordsAdded: index % 300,
  notesCreated: index % 3,
  edits: index % 5,
  tasksCompleted: index % 4,
  focusMinutes: index % 50,
});

for (const count of [1000, 10000, 100000]) {
  const days = Array.from({ length: count }, (_, index) => sample(index));
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  let total = 0;
  for (const day of days) total += computeContribution(day, settings);
  const elapsed = performance.now() - start;
  const heap = process.memoryUsage().heapUsed - before;
  console.log(
    `days=${count}  elapsed=${elapsed.toFixed(1)}ms  heapDelta=${(heap / 1024 / 1024).toFixed(2)}MB  checksum=${total}`
  );
}
