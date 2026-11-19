import fs from "node:fs";

const source = "CHANGELOG.md";
const target = "src/changelog.ts";
const markdown = fs.readFileSync(source, "utf8");
const output = `// 由 scripts/sync-changelog.mjs 从 CHANGELOG.md 自动生成，请勿手动修改。
export const CHANGELOG = ${JSON.stringify(markdown)};
`;
fs.writeFileSync(target, output, "utf8");
console.log(`synced ${source} -> ${target} (${markdown.length} chars)`);
