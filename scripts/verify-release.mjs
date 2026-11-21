import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tag = (process.argv[2] ?? "").replace(/^v/, "");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const bridge = fs.readFileSync(path.join(root, "mcp-server", "index.mjs"), "utf8");

const versions = [pkg.version, manifest.version];
if (new Set(versions).size !== 1) {
  console.error(`版本不一致：package.json=${pkg.version}，manifest.json=${manifest.version}`);
  process.exit(1);
}
if (tag && tag !== manifest.version) {
  console.error(`标签版本 ${tag} 与 manifest 版本 ${manifest.version} 不一致`);
  process.exit(1);
}
if (!bridge.includes(`version: "${manifest.version}"`)) {
  console.error("MCP bridge serverInfo 版本与 manifest 不一致");
  process.exit(1);
}

for (const file of ["main.js", "manifest.json", "styles.css", "mcp-server/index.mjs"]) {
  if (!fs.existsSync(path.join(root, file)) || fs.statSync(path.join(root, file)).size === 0) {
    console.error(`发布文件缺失或为空：${file}`);
    process.exit(1);
  }
}

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${manifest.version}]`)) {
  console.error(`CHANGELOG 缺少版本 ${manifest.version}`);
  process.exit(1);
}

// README 版本徽章（shields.io 格式 version-vX.Y.Z）须与 manifest 版本一致；中英文各一份。
for (const name of ["README.md", "README.zh-CN.md"]) {
  const readme = fs.readFileSync(path.join(root, name), "utf8");
  if (!readme.includes(`version-v${manifest.version}`)) {
    console.error(`${name} 版本徽章缺少 version-v${manifest.version}（与 manifest 版本不一致）`);
    process.exit(1);
  }
}

// versions.json 须含当前版本键（Obsidian 据此匹配最低 App 版本）。
const versionsMap = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));
if (!Object.prototype.hasOwnProperty.call(versionsMap, manifest.version)) {
  console.error(`versions.json 缺少版本键 ${manifest.version}`);
  process.exit(1);
}

console.log(`Release ${manifest.version} verified`);
