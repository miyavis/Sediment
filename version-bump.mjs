import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("npm_package_version is not set. Run this via npm version.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

// MCP 桥接的 serverInfo 版本与插件保持同步。
const bridgePath = "mcp-server/index.mjs";
const bridge = readFileSync(bridgePath, "utf8");
const updated = bridge.replace(
  /serverInfo: \{ name: "sediment", version: "[^"]+" \}/,
  `serverInfo: { name: "sediment", version: "${targetVersion}" }`
);
if (updated !== bridge) writeFileSync(bridgePath, updated, "utf8");
