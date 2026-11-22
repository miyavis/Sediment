import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "main.js",
    "esbuild.config.mjs",
    "scripts/**",
    "src/changelog.ts",
    "src/agent/bridge-source.ts",
    "tests/**",
    "examples/**",
    "mcp-server/**",
    ".obsidian/**",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mjs"] },
      },
    },
    rules: {
      // 项目既有约定：测试中允许显式 any，保留非空断言与 console
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
      // AgentApi 的审核队列已改为显式委托，无类/接口合并，保留默认即可
    },
  },
]);
