import fs from "node:fs";

const version = process.argv[2];
const markdown = fs.readFileSync("CHANGELOG.md", "utf8");
const sections = markdown.split(/^## /m).slice(1);
const target = version ? sections.find((s) => s.startsWith(`[${version}]`)) : sections[0];
if (!target) {
  console.error(`找不到版本 ${version} 的变更记录`);
  process.exit(1);
}
console.log(`## ${target.trim()}`);
