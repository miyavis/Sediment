# Sediment

> 把每天的工作，沉淀成自己的知识地层。

Sediment 是一个本地优先的 Obsidian 插件，把知识工作统计、快速速记、周期复盘和受控的 Agent 协作放在同一个工作流中。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.9.6.1.1.1-blue.svg)](https://github.com/miyavis/Sediment/releases)

## 核心入口

| 入口 | 用途 |
| --- | --- |
| **今日** | 今日目标、快速速记、番茄钟、本地待办和 Agent 动态 |
| **知识** | 热力图、写作趋势、投入分布、年度画像和周期复盘 |
| **Agent** | 草稿审核、待办认领、变更审查、快照恢复和工作日志 |

支持精简、标准、完整三档布局密度。移动端优先保留速记、今日任务和摘要；复杂分析与 Agent 管理继续放在桌面端。

## 快速开始

### BRAT 安装

1. 安装并启用 BRAT。
2. 在 BRAT 中选择 **Add Beta plugin**。
3. 输入 `miyavis/Sediment`。
4. 在 Obsidian 的第三方插件列表中启用 Sediment。

### 手动安装

1. 从 [Releases](https://github.com/miyavis/Sediment/releases) 下载 `sediment-vX.Y.Z.zip` 并解压。
2. 把整个 `sediment/` 目录复制到 `<vault>/.obsidian/plugins/`。
3. 在 Obsidian 设置 → 第三方插件中启用 Sediment。

包内包含 `main.js`、`manifest.json`、`styles.css`、`mcp-server/index.mjs`（Agent 用，可不要）和 `安装说明.md`。也可只下单个文件，或复制仓库现成的 [`dist/sediment`](./dist/sediment)。

### 怎么找到 `.obsidian`

`.obsidian` 是 **vault 根目录下的隐藏文件夹**，不在插件仓库里。

- Windows 资源管理器：查看 → 显示 → 勾选「隐藏的项目」；也可在地址栏粘贴 `<vault 路径>\.obsidian\plugins\sediment`（把 `<vault 路径>` 换成你的库根目录）
- macOS Finder：`Cmd + Shift + .` 显示隐藏文件
- Linux：文件管理器按 `Ctrl + H`，或终端执行 `ls -a`

目标结构是 `<vault>/.obsidian/plugins/sediment/`。

首次打开插件时：

1. 在设置中确认日记目录和文件名格式。
2. 了解数据位置和自动备份设置。
3. 使用“记一条速记”或 `obsidian://sediment?action=memo&text=想法` 快速开始。
4. Agent 接入是可选项。

## 常用功能

- **写作统计**：新增词数、编辑会话、新建笔记、完成任务和专注分钟。
- **速记**：普通 Markdown Callout、图片附件、标签筛选、回顾、漫步和沉淀。
- **待办**：扫描原生复选框；可委派给 Agent，并定位回原笔记和行号。
- **周复盘与分析**：本期结论、未完成事项、知识成果、下一步行动和详细图表。
- **Agent 草稿**：保留来源，可采纳、合并、驳回或恢复。
- **本地数据**：核心数据保存在 `.obsidian/plugins/sediment/data.json`；支持库内备份和脱敏导出。
- **界面适配**：中英文、浅色/深色主题、窄屏布局、减少动态效果和布局密度。

贡献公式：

```text
贡献分 = 新建笔记×2 + 编辑会话 + 完成任务
       + floor(新增词数/100)
       + floor(专注分钟/25)
```

公式权重和单日封顶可在设置中调整。贡献分是辅助指标，不代表知识质量。

## 常用命令

- 打开知识脉冲看板
- 打开速记面板
- 记一条速记
- 生成本周工作复盘
- 记录今日遗留待办到日记
- 备份统计数据到库内
- 导出今日战报图片
- 查看诊断日志
- 一键卸载 MCP 接入
- 查看更新记录

## 设置要点

- 日记目录、文件名格式和速记段落标题
- 复盘目录、工作日志目录和知识沉淀目录
- 热力图指标、统计编辑会话、写作目标和贡献公式
- Agent 禁止目录/标签、白名单和操作权限
- 修改前快照、库内备份目录和保留份数
- 界面密度、画风、语言和减少动态效果
- 本地 Agent API 端口和令牌

Agent 工作模式：

| 模式 | 影响 |
| --- | --- |
| 只读 | 可检索和读取允许范围 |
| 草稿 | 可生成草稿，不直接修改已有笔记 |
| 确认后写入 | 写入前预览、确认并保留快照 |
| 自动执行 | 仅在明确允许的范围内自动执行 |

详细操作开关始终作为硬限制。

## Agent 接入

Agent 可通过插件内 API、本地 HTTP API 或 MCP stdio 桥接使用。

```text
OpenCode / Qoder / Claude Code / Cursor
        │ MCP stdio
        ▼
mcp-server/index.mjs
        │ HTTP
        ▼
127.0.0.1:27123
```

开启步骤：

1. 在设置中启用本地 Agent API。
2. 保留自动生成的访问令牌。
3. 使用“自动配置智能体客户端”，或复制配置 JSON。
4. 重启对应客户端。

BRAT 安装时插件目录只有三件套，没有 `mcp-server/` 是正常的：点「一键配置智能体客户端」后，插件会把内嵌的桥接脚本自动写到 `<vault>/.obsidian/plugins/sediment/mcp-server/index.mjs`。也可以从整包 zip 里复制该文件。

OpenCode 示例（把 `<vault>` 换成你的库根目录）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sediment": {
      "type": "local",
      "command": ["node", "<vault>/.obsidian/plugins/sediment/mcp-server/index.mjs"],
      "environment": {
        "SEDIMENT_URL": "http://127.0.0.1:27123",
        "SEDIMENT_TOKEN": "设置里的令牌",
        "AGENT_NAME": "opencode"
      },
      "enabled": true
    }
  }
}
```

公开 MCP 工具收敛为 13 个任务型入口，覆盖上下文读取、检索、笔记、速记、知识沉淀、任务、变更审查和高级只读状态聚合。旧细粒度工具名已删除，不再保留兼容入口。

主要入口：

- 上下文：`get_daily_context`、`get_active_context`
- 检索与读取：`search_notes`、`list_notes`、`read_note`
- 写入：`write_note`、`patch_note`
- 沉淀：`add_memo`、`add_knowledge`、`record_work_log`
- 任务：`manage_tasks`
- 审查：`manage_changes`
- 高级只读状态：`get_workspace_state`（统计、图谱、番茄钟、周复盘、调用活动、工作日志、分类）

安全边界：

- 本地服务只监听 `127.0.0.1`
- 未提供有效令牌时拒绝请求
- `.obsidian/` 和 `.git/` 始终禁止访问
- 黑名单目录和标签不可读、不可写、不可检索
- 高风险操作可用快照、Diff 和恢复点审查

完整工具清单可通过 MCP `tools/list` 查询。

**API 版本**：`AGENT_API_VERSION = 1`（`/health` 返回 `agentApiVersion`）。工具名或参数结构变更时递增该版本；同一版本内不会删除或重命名已有工具，客户端可按版本决定兼容策略。

## 数据与恢复

- 主数据：`.obsidian/plugins/sediment/data.json`
- 日记：由日记目录和文件名格式决定
- 备份：默认写入库内 `sediment-backup/`
- 未知数据版本或异常格式：暂停写入并保留恢复副本
- 卸载插件不会主动删除 vault 中的普通目录、日记或备份

升级前建议执行一次“备份统计数据到库内”。反馈问题时不要附带令牌、私密笔记全文或完整 `data.json`。

## 开发与验证

```sh
npm install
npm run dev
npm run build
npm test
npm run test:release
```

- `npm run build`：同步版本、文档和 MCP bridge、类型检查、生成 `main.js`
- `npm test`：运行单元测试和 MCP 冒烟
- `npm run test:release`：校验版本、CHANGELOG 和发布产物

**版本号只有一个源**：`package.json` 的 `version`。构建时 `version-bump.mjs` 自动同步到 `package-lock.json`、`manifest.json`、`versions.json`、`mcp-server/index.mjs` 的 `serverInfo` 和 README 版本徽章。发版流程：

```sh
npm run release:prepare -- 0.9.3   # 自动把 CHANGELOG 的 [Unreleased] 定稿，并改 package.json 版本
npm run build                      # 自动同步所有位置并生成 dist/sediment
git add -A
git commit -m "release: v0.9.3"
git tag v0.9.3
git push origin main --tags
```

`release:prepare` 只做两件事：把 `## [Unreleased]` 改成 `## [0.9.3] - 日期`，并把 `package.json` 的 `version` 改成 `0.9.3`。其余位置由 `npm run build` 自动同步。CI 打 tag 时也会自动执行这一步。

项目结构：

```text
src/                 插件入口、数据、统计、Agent、界面
tests/               单元测试与 Obsidian 桩
scripts/             构建同步、测试和发布校验
mcp-server/          MCP stdio 桥接
.github/workflows/   CI 与 Release
```

## 已知边界

- 没有云授权或云同步，核心内容不上传
- 语义检索使用本地 TF-IDF，不依赖大型 embedding 模型
- 手机端适合快速捕获与任务摘要；Agent API 为桌面能力
- 数据迁移、大 vault 性能和真实移动端可用性仍需持续基准验证

## 更新记录

版本变更见 [CHANGELOG.md](./CHANGELOG.md)。发布与兼容说明见 [Release](https://github.com/miyavis/Sediment/releases)。

## 许可

MIT © miyavis &lt;miyavis521@gmail.com&gt;
