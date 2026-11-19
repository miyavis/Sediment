// 纯函数单测运行器：esbuild 把 TS 测试打成 CJS，用 fake obsidian 顶替真实模块后在 Node 里跑。
// 不引入任何测试框架依赖，只用 Node 内置 node:test。
import { build } from "esbuild";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stubPath = path.join(root, "tests", "obsidian-stub.cjs");
const outfile = path.join(root, "tests", ".unit.bundle.cjs");

await build({
  entryPoints: [path.join(root, "tests", "unit.test.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["obsidian"],
  logLevel: "warning",
});

// 拦截 require("obsidian")，返回无副作用的桩模块。
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return origLoad(stubPath, parent, isMain);
  return origLoad(request, parent, isMain);
};

// 加载打包后的测试文件，node:test 会自动执行注册的用例并输出结果。
const require = Module.createRequire(import.meta.url);
require(outfile);