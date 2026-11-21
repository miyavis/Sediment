import { readFileSync, writeFileSync } from "node:fs";

/** 发版准备：把 CHANGELOG 的 [Unreleased] 定稿为版本号，并更新版本源 package.json。 */
const raw = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：npm run release:prepare -- 0.9.3");
  process.exit(1);
}

const changelogPath = "CHANGELOG.md";
let changelog = readFileSync(changelogPath, "utf8");
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG already contains ${version}, skip heading update`);
} else {
  const today = new Date().toISOString().slice(0, 10);
  const updated = changelog.replace(
    /^## \[Unreleased\]$/m,
    `## [${version}] - ${today}`
  );
  if (updated === changelog) {
    console.error("CHANGELOG.md 中没有 [Unreleased] 标题，无法自动定稿");
    process.exit(1);
  }
  changelog = updated;
  writeFileSync(changelogPath, changelog, "utf8");
}

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

console.log(`release prepared: ${version} (CHANGELOG + package.json)`);
