import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "sediment");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "mcp-server"), { recursive: true });

const files = [
  ["main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
  ["mcp-server/index.mjs", "mcp-server/index.mjs"],
];
for (const [from, to] of files) {
  copyFileSync(path.join(root, from), path.join(out, to));
}

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

writeFileSync(
  path.join(out, "安装说明.md"),
  [
    "# Sediment 安装",
    "",
    `版本 ${version}`,
    "",
    "## 手动安装",
    "",
    "1. 把 `main.js`、`manifest.json`、`styles.css` 三个文件复制到：",
    "   `<Obsidian库>/.obsidian/plugins/sediment/`",
    "2. 在 Obsidian 设置 → 第三方插件中启用 Sediment。",
    "3. 若要接入 Qoder / OpenCode 等智能体：在插件设置里点「一键配置」，桥接脚本会自动写入插件目录，无需手动复制。",
    "",
    "## BRAT 安装",
    "",
    "仓库地址：`miyavis/Sediment`",
    "",
    "## 说明",
    "",
    "- 数据保存在 `<Obsidian库>/.obsidian/plugins/sediment/data.json`。",
    "- 本地 Agent API 只监听 127.0.0.1，令牌在插件设置里生成。",
    "- 完整文档：https://github.com/miyavis/Sediment#readme",
    "",
  ].join("\n"),
  "utf8"
);

console.log(`packaged: dist/sediment (v${version})`);
