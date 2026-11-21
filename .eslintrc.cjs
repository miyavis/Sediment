module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { browser: true, node: true, es2020: true },
  parserOptions: { ecmaVersion: 2020, sourceType: "module" },
  ignorePatterns: [
    "dist/",
    "main.js",
    "tests/.unit.bundle.cjs",
    "tests/.bench.bundle.cjs",
    "src/changelog.ts",
    "src/agent/bridge-source.ts",
    "mcp-server/index.mjs",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-console": "off",
  },
};
