import fs from "node:fs";

const source = "CHANGELOG.md";
const target = "src/changelog.ts";
// 统一 LF：避免 Windows 的 CRLF 被固化进生成文件，导致 Linux CI 构建产物不一致。
const markdown = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const output = `// 由 scripts/sync-changelog.mjs 从 CHANGELOG.md 自动生成，请勿手动修改。
export const CHANGELOG = ${JSON.stringify(markdown)};
`;
fs.writeFileSync(target, output, "utf8");
console.log(`synced ${source} -> ${target} (${markdown.length} chars)`);
