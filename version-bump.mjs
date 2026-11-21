import { readFileSync, writeFileSync } from "node:fs";

/**
 * 版本号唯一同步器。
 * 唯一源：package.json 的 version（或命令行显式传入，用于测试）。
 * 每次 build 都会调用，确保所有位置自动一致。
 */
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = process.argv[2] || pkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`非法版本号：${version}`);
  process.exit(1);
}

const writeIfChanged = (path, content) => {
  const current = readFileSync(path, "utf8");
  if (current !== content) writeFileSync(path, content, "utf8");
};

// 1. package.json：命令行传版本时也写回，保证单一源始终最新。
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

// 2. package-lock.json：只改顶层与根包两处版本，保留依赖版本与格式。
const lockPath = "package-lock.json";
let lock = readFileSync(lockPath, "utf8");
lock = lock.replace(/^  "version": "[^"]+"/m, `  "version": "${version}"`);
lock = lock.replace(/^(      "version": )"[^"]+"/m, `$1"${version}"`);
writeIfChanged(lockPath, lock);

// 3. manifest.json
const manifestPath = "manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeIfChanged(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");

// 4. versions.json
const versionsPath = "versions.json";
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[version] = manifest.minAppVersion;
writeIfChanged(versionsPath, JSON.stringify(versions, null, "\t") + "\n");

// 5. MCP 桥接 serverInfo
const bridgePath = "mcp-server/index.mjs";
const bridge = readFileSync(bridgePath, "utf8");
writeIfChanged(
  bridgePath,
  bridge.replace(
    /serverInfo: \{ name: "sediment", version: "[^"]+" \}/,
    `serverInfo: { name: "sediment", version: "${version}" }`
  )
);

// 6. README 版本徽章（英文主文档 + 中文翻译各一份）
for (const readmePath of ["README.md", "README.zh-CN.md"]) {
  const readme = readFileSync(readmePath, "utf8");
  writeIfChanged(readmePath, readme.replace(/version-v\d+(?:\.\d+)*/g, `version-v${version}`));
}

console.log(`version synced: ${version}`);
