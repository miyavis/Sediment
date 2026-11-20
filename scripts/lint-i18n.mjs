/**
 * i18n 防再犯扫描（Task 8）：
 * 检查 src 内 createEl/createDiv/createSpan 的 text/cls 参数中，
 * 是否存在未被 t()/tf() 包裹的字面量中文（含模板字符串）。
 *
 * 白名单：
 * - src/i18n.ts 自身（ZH 键表）不扫描；tests/ 不在扫描范围。
 * - 注释中的中文不视为违规（扫描前先剥离注释）。
 * - 行内或上一行注释含 `i18n-lint-allow` 时放行该处违规。
 *
 * 用法：node scripts/lint-i18n.mjs（已挂进 npm test 链）。
 * 纯函数 stripComments/findViolations 导出供单测自测。
 */
import fs from "node:fs";
import path from "node:path";

const CJK = /[\u4e00-\u9fff]/;
const ALLOW_MARKER = "i18n-lint-allow";

/**
 * 剥离 // 与 /* *\/ 注释（替换为等长空格，保留换行以维持行号），
 * 字符串/模板字面量原样保留；正确处理模板 ${} 插值内的嵌套代码与注释。
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | single | double | template
  // 模板插值栈：进入 `${` 时压栈，记录插值内花括号深度。
  const interp = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { mode = "single"; out += c; i += 1; continue; }
      if (c === '"') { mode = "double"; out += c; i += 1; continue; }
      if (c === "`") { mode = "template"; out += c; i += 1; continue; }
      const top = interp[interp.length - 1];
      if (top) {
        if (c === "{") top.depth += 1;
        else if (c === "}") {
          if (top.depth === 0) { interp.pop(); mode = "template"; out += c; i += 1; continue; }
          top.depth -= 1;
        }
      }
      out += c; i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; } else out += " ";
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " ";
      i += 1; continue;
    }
    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === quote) mode = "code";
      out += c; i += 1; continue;
    }
    // template
    if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
    if (c === "`") { mode = "code"; out += c; i += 1; continue; }
    if (c === "$" && next === "{") { interp.push({ depth: 0 }); mode = "code"; out += "${"; i += 2; continue; }
    out += c; i += 1; continue;
  }
  return out;
}

/** 从 openParen 处扫描配对的右括号，跳过字符串/模板内容，返回调用参数文本。 */
function callArgs(src, openParen) {
  let depth = 0;
  let i = openParen;
  let mode = "code";
  const interp = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) return src.slice(openParen + 1, i);
      } else {
        const top = interp[interp.length - 1];
        if (top) {
          if (c === "{") top.depth += 1;
          else if (c === "}") {
            if (top.depth === 0) { interp.pop(); mode = "template"; }
            else top.depth -= 1;
          }
        }
      }
      i += 1; continue;
    }
    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (c === "\\") { i += 2; continue; }
      if (c === quote) mode = "code";
      i += 1; continue;
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "`") { mode = "code"; i += 1; continue; }
    if (c === "$" && next === "{") { interp.push({ depth: 0 }); mode = "code"; i += 2; continue; }
    i += 1; continue;
  }
  return src.slice(openParen + 1);
}

/** 把字符串/模板字面量内容替换为等长空格（保留引号与换行），用于属性名定位。 */
function maskLiterals(src) {
  return src.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) =>
    literal[0] + literal.slice(1, -1).replace(/[^\n]/g, " ") + literal[literal.length - 1]
  );
}

/** 从 start 读取一个属性值表达式，直到同层逗号或闭合括号为止。 */
function propValue(src, start) {
  let depth = 0;
  let mode = "code";
  const interp = [];
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "'") { mode = "single"; continue; }
      if (c === '"') { mode = "double"; continue; }
      if (c === "`") { mode = "template"; continue; }
      const top = interp[interp.length - 1];
      if (top) {
        // 模板插值内部：花括号配对归插值栈管理，逗号/括号不影响外层切分。
        if (c === "{") top.depth += 1;
        else if (c === "}") {
          if (top.depth === 0) { interp.pop(); mode = "template"; }
          else top.depth -= 1;
        }
        continue;
      }
      if (c === "(" || c === "{" || c === "[") { depth += 1; continue; }
      if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return src.slice(start, i);
        depth -= 1;
        continue;
      }
      if (c === "," && depth === 0) return src.slice(start, i);
      continue;
    }
    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (c === "\\") { i += 1; continue; }
      if (c === quote) mode = "code";
      continue;
    }
    if (c === "\\") { i += 1; continue; }
    if (c === "`") { mode = "code"; continue; }
    if (c === "$" && next === "{") { interp.push({ depth: 0 }); mode = "code"; i += 1; continue; }
  }
  return src.slice(start);
}

/** 取模板字面量的静态片段（剔除 ${…} 插值源码，插值内的 t() 不算违规）。 */
function templateStaticParts(body) {
  const parts = [];
  let current = "";
  let i = 0;
  let depth = -1; // -1 = 模板静态区；>=0 = 插值内花括号深度
  while (i < body.length) {
    const c = body[i];
    const next = body[i + 1];
    if (depth < 0) {
      if (c === "\\") { current += c + (next ?? ""); i += 2; continue; }
      if (c === "$" && next === "{") { parts.push(current); current = ""; depth = 0; i += 2; continue; }
      current += c; i += 1; continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0) { depth = -1; i += 1; continue; }
      depth -= 1;
    }
    i += 1;
  }
  parts.push(current);
  return parts;
}

/**
 * 找出 createEl/createDiv/createSpan 的 text/cls 值里未被 t()/tf() 直接包裹的中文字面量。
 * 模板字面量只检查静态片段（${…} 内的 t()/tf() 视为已翻译）。
 * 返回 [{ file, line, key, snippet }]；line 为 1 起始行号。
 */
export function findViolations(source, file = "<source>") {
  const stripped = stripComments(source);
  const lines = source.split("\n");
  const strippedLines = stripped.split("\n");
  const violations = [];
  const callRe = /\bcreate(?:El|Div|Span)\s*\(/g;
  let match;
  while ((match = callRe.exec(stripped)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const args = callArgs(stripped, openParen);
    const masked = maskLiterals(args);
    const propRe = /(?:^|[,{])\s*(text|cls)\s*:/g;
    let prop;
    while ((prop = propRe.exec(masked)) !== null) {
      const valueStart = prop.index + prop[0].length;
      const value = propValue(args, valueStart);
      const literalRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
      let lit;
      while ((lit = literalRe.exec(value)) !== null) {
        const isTemplate = lit[1] === "`";
        const textToCheck = isTemplate ? templateStaticParts(lit[2]).join("") : lit[2];
        if (!CJK.test(textToCheck)) continue;
        const before = value.slice(0, lit.index);
        // 直接作为 t("…") / tf("…", …) 的首参视为已翻译；模板字面量 tf(`中文 {n}`) 同样豁免。
        if (/\btf?\(\s*$/.test(before)) continue;
        const absolute = openParen + 1 + valueStart + lit.index;
        const line = stripped.slice(0, absolute).split("\n").length;
        // 白名单 marker 只在注释中生效：原文含 marker 且剥离注释后消失，才说明它写在注释里；
        // 若 marker 落在字符串字面量内（剥离后仍在），不得自我放行。
        const allowOriginal = (lines[line - 1] ?? "") + (lines[line - 2] ?? "");
        const allowStripped = (strippedLines[line - 1] ?? "") + (strippedLines[line - 2] ?? "");
        if (allowOriginal.includes(ALLOW_MARKER) && !allowStripped.includes(ALLOW_MARKER)) continue;
        violations.push({
          file,
          line,
          key: prop[1],
          snippet: lit[0].length > 60 ? `${lit[0].slice(0, 57)}...` : lit[0],
        });
      }
    }
  }
  return violations;
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export function scanSrc(root) {
  const srcDir = path.join(root, "src");
  const violations = [];
  for (const file of listTsFiles(srcDir)) {
    // i18n.ts 是 ZH 键表本身，天然充满中文字面量。
    if (path.basename(file) === "i18n.ts") continue;
    violations.push(...findViolations(fs.readFileSync(file, "utf8"), path.relative(root, file)));
  }
  return violations;
}

function main() {
  // 直接运行时 argv[1] 即本脚本路径，据此定位仓库根（避免 import.meta，兼容被单测打包）。
  const root = path.dirname(path.dirname(path.resolve(process.argv[1])));
  const violations = scanSrc(root);
  if (violations.length > 0) {
    console.error(`i18n lint: ${violations.length} 处未走 t()/tf() 的中文字面量：`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.key}] ${v.snippet}`);
    }
    console.error("修法：用 t(\"中文\") / tf(\"中文 {n}\", { n }) 包裹，并在 src/i18n.ts 的 EN 表同步英文；确属例外可在该行或上一行注释标注 i18n-lint-allow。");
    process.exit(1);
  }
  console.log("i18n lint OK — createEl/createDiv/createSpan 的 text/cls 无未翻译中文字面量。");
}

// 直接运行时执行扫描；被单测 import 时不自动运行。
// 用 resolve(argv[1]) 与本脚本规范路径（<仓库根>/scripts/lint-i18n.mjs）精确比对，
// 取代 endsWith 后缀匹配：避免 my-scripts/lint-i18n.mjs 之类误触发，并消除 Windows 分隔符差异。
// 注：esbuild 把本模块打进 CJS 单测包时 import.meta 会被置空，故不能用 import.meta.url 取自身路径。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const scriptPath = invokedPath
  ? path.resolve(path.dirname(path.dirname(invokedPath)), "scripts", "lint-i18n.mjs")
  : "";
if (invokedPath && invokedPath === scriptPath) {
  main();
}