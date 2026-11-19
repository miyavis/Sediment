# Sediment

> **把每天的工作，沉淀成自己的知识地层。**
> 本地优先的 Obsidian 知识工作看板与智能体知识沉淀插件。
> 受 [Crisp Pulse](https://github.com/letschips/crisp-pulse) 的功能介绍启发，从零实现。代码为原创，不复制原插件任何源码。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 功能

- **GitHub 风格热力图看板**：近 7 / 13 / 26 / 53 周活跃全景，六项指标自由切换（贡献分、新增词数、编辑会话、新建笔记、完成任务、专注分钟），点击某天看当日明细。
- **写作统计**：监听 vault 变化，统计新增/删除词数、有效编辑会话、新建笔记和任务勾选；同一文件同一天最多记一次编辑会话，避免刷分。
- **flomo 式速记**：命令「记一条速记」回车即记，写入当天日记的 `## 速记` 段落；独立的速记面板支持按天分组、搜索和标签筛选；`Ctrl/Cmd + Enter` 快速提交。
- **周复盘**：一键生成本周 Markdown 报告，含本期/上期对比、每日明细、速记清单与「值得回看」线索，归档到 `reviews/` 并自动打开。
- **数据分析**：每日写作柱状图、写作变化折线、时间投入、写作来源、投入去向、活跃时段（小时 × 星期矩阵）与投入节律矩阵。
- **年度画像**：年轮、知识指纹、月相日历、知识地层，以及可左右切换、可导出 PNG 的月报海报。
- **画风切换**：像素湖面 / 水墨山水 / 像素城市三种画风；顶部天体随时段沿弧线更新，夜间按月相显示月亮，每分钟平滑刷新。
- **速记增强**：粘贴图片自动存进附件目录、每日回顾（去年今日 / 上月今日）、本地相似度「漫步」、标签树筛选、搜索与 `Ctrl/Cmd+Enter` 提交。
- **内置番茄钟**：25/5/15 分钟工作与休息，状态栏倒计时，完成自动记入 `focusMinutes`；Agent 也能通过 `get_pomodoro` / `control_pomodoro` 查看和控制。
- **Agent 接入**：本地 HTTP API + MCP stdio 桥接，把整个 vault 变成 Agent 可读写、可搜索的个人知识库；另支持 `obsidian://` 快速捕捉。
- **数据安全**：所有统计本地完成，存在插件目录的 `data.json`；不上传任何笔记内容。

贡献公式公开透明：

```
贡献分 = 新建笔记×2 + 编辑会话 + 完成任务 + floor(新增词数/100) + floor(专注分钟/25)
```

---

## 安装方式

和 Crisp Pulse 一样，支持 **BRAT** 与 **手动安装** 两种方式。

### 方式一：通过 BRAT 安装（推荐）

1. 在 Obsidian 中安装并启用 **BRAT** 插件；
2. 打开 BRAT 设置，点击 **Add Beta plugin**；
3. 输入仓库地址：`miyavis/Sediment`；
4. 添加后在「第三方插件」列表中启用 **Sediment** 即可。

> BRAT 会克隆仓库并执行 `npm install && npm run build`，因此仓库里保留 `package.json` 和 `src/` 即可。

### 方式二：手动安装

1. 从 [Releases](https://github.com/miyavis/Sediment/releases) 页面下载最新发布包（包含 `main.js`、`manifest.json`、`styles.css`）；
2. 打开 Obsidian 库目录，进入 `.obsidian/plugins/`；
3. 新建文件夹 `sediment`，把三个文件放进去；
4. 在 Obsidian 设置 →「第三方插件」中重新载入并启用 **Sediment**。

> Release 里的三个文件由 `.github/workflows/release.yml` 在发布时自动构建并上传。

### 自己构建

```sh
npm install
npm run build
```

把根目录的 `main.js`、`manifest.json`、`styles.css` 复制到 `.obsidian/plugins/sediment/` 即可。开发时运行 `npm run dev` 进入 watch 模式。

---

## 命令

| 命令 | 说明 |
| --- | --- |
| 打开知识脉冲看板 | 打开热力图看板视图 |
| 打开速记面板 | 打开右侧速记视图 |
| 记一条速记 | 弹出输入框，快速记录 |
| 生成本周工作复盘 | 生成并打开本周复盘笔记 |

左侧功能区还有「看板」和「速记」两个快捷图标。

---

## Agent 接入（个人知识库）

插件把整个 vault 暴露成可供 Agent 调用的知识库，三层入口共用同一套实现：

1. **插件内 API**：`app.plugins.plugins["sediment"].agentApi`，或全局 `window.Sediment.api`，Templater / QuickAdd / 脚本可直接调用。
2. **本地 HTTP API**：只监听 `127.0.0.1`，需 `Authorization: Bearer <token>` 或 `?token=`。
3. **MCP stdio 桥接**：`mcp-server/index.mjs`，把笔记搜索、读写、速记和统计暴露成 MCP 工具。

### 开启步骤

1. 在插件设置 →「Agent 接入」里勾选 **启用本地 Agent API**，点击 **生成新令牌**；
2. 记下令牌（只显示在这里，保存在 `data.json`）；
3. 在 Agent 客户端里配置 MCP 桥接。

**OpenCode 配置示例**（`opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sediment": {
      "type": "local",
      "command": ["node", "D:/project/Obsidian_plugin/mcp-server/index.mjs"],
      "environment": {
        "SEDIMENT_URL": "http://127.0.0.1:27123",
        "SEDIMENT_TOKEN": "把设置里的令牌粘过来"
      },
      "enabled": true
    }
  }
}
```

**Claude Desktop / 其它 MCP 客户端**：

```json
{
  "mcpServers": {
    "sediment": {
      "command": "node",
      "args": ["D:/project/Obsidian_plugin/mcp-server/index.mjs"],
      "env": {
        "SEDIMENT_URL": "http://127.0.0.1:27123",
        "SEDIMENT_TOKEN": "把设置里的令牌粘过来"
      }
    }
  }
}
```

### MCP 工具

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 全文搜索，返回命中片段 |
| `list_notes` | 列出笔记，可按文件夹过滤 |
| `read_note` | 读取笔记全文 |
| `create_note` | 新建笔记 |
| `append_note` | 追加到已有笔记 |
| `add_memo` | 记一条速记到当天日记 |
| `get_stats` | 最近 N 天指标 |
| `get_today` | 今日快照 |
| `get_memos` / `get_backlog` | 速记与未转化积压 |
| `generate_weekly_review` | 生成周复盘 Markdown |
| `get_daily_context` | 开工上下文包（今日状态 + 近期工作日志 + 速记 + 笔记） |
| `record_work_log` | 沉淀一次智能体工作：任务/完成/决策/文件/经验/待确认 |
| `add_knowledge` | 把结论写成带 frontmatter 的独立知识笔记 |
| `list_work_logs` | 列出最近 N 天所有智能体工作日志 |

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/notes?folder=&limit=` | 列出笔记 |
| GET | `/search?q=&limit=` | 全文搜索 |
| GET | `/note?path=` | 读取笔记 |
| POST | `/note` | `{path, content, mode: create/overwrite/append}` |
| POST | `/memo` | `{text, tags}` |
| GET | `/stats?days=` | 每日指标 |
| GET | `/today` | 今日快照 |
| GET | `/memos?limit=` / `/backlog` | 速记 |
| GET | `/review?date=` | 周复盘 |
| GET | `/context?days=` | 每日上下文包 |
| POST | `/worklog` | `{agent, task, summary, decisions, files, learnings, openQuestions, tags}` |
| POST | `/knowledge` | `{title, content, folder?, tags?, agent?, source?, links?}` |
| GET | `/worklogs?days=` | 工作日志列表 |

### URL 快速捕捉

在快捷指令 / Raycast / Alfred 里调用：

```
obsidian://sediment?action=memo&text=一个想法&tags=灵感,阅读
obsidian://sediment?action=dashboard
```

> 安全说明：服务只绑定回环地址，且令牌必填；不开启时不会监听任何端口。所有数据仍留在本地。

---

## 让智能体沉淀每天的工作

把上面的 MCP 配到 **Qoder / OpenCode / Claude Code** 等智能体后，建议固定两个习惯：

- **开工时**调用 `get_daily_context`：一次拿到今日状态、最近 7 天工作日志、待转化速记和最近笔记，接着之前的工作往下做。
- **收工时**调用 `record_work_log`：把本次任务、完成内容、决策、涉及文件、学到的东西和待确认事项写进 `agent-logs/YYYY-MM-DD.md`；价值高的结论再用 `add_knowledge` 生成独立笔记（自动带日期、来源、标签、双链的 frontmatter）。

可以在智能体规则文件（如 `AGENTS.md`、OpenCode 的指令文件）里放这段提示词：

```text
每个工作日：
开工时先调用 get_daily_context 了解上下文。
收工时必须调用 record_work_log，agent 填 "opencode" 或 "qoder"，
写清本次任务、关键决策、涉及文件和可复用结论。
若产生了值得长期保留的知识，再调用 add_knowledge 生成独立笔记并给出标题与标签。
```

这样每天智能体做过什么、得出什么结论都会留在自己的库里，日积月累成为可搜索、可双链的个人知识资产。

---

## 设置

- **日记文件夹 / 文件名格式**：速记写在哪里，默认 `daily/YYYY-MM-DD.md`。
- **速记段落标题**：默认 `## 速记`。
- **每周起始日**：周一或周日，影响周复盘和热力图列对齐。
- **热力图默认指标**：打开看板时默认展示的指标。
- **统计有效编辑会话**：关闭后不再累计编辑会话数。
- **复盘归档文件夹**：默认 `reviews/`。

---

## 项目结构

```
.
├── src/
│   ├── main.ts                  # 插件入口、命令、视图注册
│   ├── types.ts                 # 数据模型与默认配置
│   ├── data/store.ts            # data.json 读写与防抖保存
│   ├── tracking/tracker.ts      # 写作统计监听
│   ├── features/memo.ts         # 速记写入日记
│   ├── features/review.ts       # 周复盘报告生成
│   ├── agent/api.ts             # Agent / 脚本共用的知识库接口
│   ├── agent/server.ts          # 127.0.0.1 HTTP API
│   ├── ui/                      # 设置页与快速速记弹窗
│   ├── views/                   # 看板与速记视图
│   └── utils/                   # 日期与路径工具
├── mcp-server/index.mjs         # MCP stdio 桥接（供 Agent 配置）
├── styles.css
├── manifest.json
├── esbuild.config.mjs
└── .github/workflows/           # Release 自动构建与上传
```

---

## 数据格式

插件数据全部保存在 `.obsidian/plugins/sediment/data.json`：

```json
{
  "version": 1,
  "days": {
    "2026-11-19": {
      "wordsAdded": 530,
      "wordsRemoved": 20,
      "edits": 3,
      "notesCreated": 1,
      "tasksCompleted": 2,
      "focusMinutes": 0,
      "contribution": 10
    }
  },
  "memos": [
    {
      "id": "lxx...",
      "date": "2026-11-19",
      "time": "14:05",
      "text": "想到什么",
      "tags": ["灵感"],
      "converted": false
    }
  ],
  "settings": {}
}
```

---

## 后续可拓展方向

- 番茄钟 / 专注插件联动（预留了 `focusMinutes` 字段）
- 年度画像、月报海报、投入节律矩阵等更多视图
- 周复盘的历史草稿与跨期行动继承
- CSV / JSON 导出与备份自愈

---

## 许可

MIT © miyavis <miyavis521@gmail.com>
