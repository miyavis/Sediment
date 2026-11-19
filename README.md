# Sediment

> **把每天的工作，沉淀成自己的知识地层。**
> 本地优先的 Obsidian 知识工作看板与智能体知识沉淀插件。
> 受 [Crisp Pulse](https://github.com/letschips/crisp-pulse) 的功能介绍启发，从零实现，代码原创。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.8.2-blue.svg)](https://github.com/miyavis/Sediment/releases)

---

## 一、它能做什么

Sediment 把 Obsidian 变成两件事：**看得见的个人知识工作看板**，以及**智能体可读写、可检索、可沉淀知识的本地知识库**。所有统计和检索都在本地完成，不上传任何笔记内容。

### 1. 三段式主看板

| 页签 | 内容 |
| --- | --- |
| **今日脉冲** | 顶部动态场景画、今天卡片（写作目标进度 + 内置番茄钟）、快速速记框、待办（今日/遗留/Agent）、今日 Agent 动态 |
| **知识地层** | 知识脉冲概览（SVG 趋势 + 活跃环形图）、53 周热力图、地平线、数据分析、年度画像、知识复盘 |
| **智能体工坊** | 连接与调用状态、人机双色热力图、AI 草稿审核流、待办队列、工作日志 |

页脚还有「更新记录」「换画风」按钮。看板始终在主编辑区打开，速记面板固定在右侧栏。

### 2. 写作统计与热力图

- 监听 vault 变化，统计新增/删除词数、有效编辑会话、新建笔记、任务勾选
- 同一文件同一天最多记一次编辑会话，避免连续键入刷分
- GitHub 风格 53 周热力图，六项指标切换：贡献分 / 新增词数 / 编辑会话 / 新建笔记 / 完成任务 / 专注分钟
- 时间跨度：近 7 天 / 30 天 / 90 天 / 今年 / 近一年
- 点击任意一天看当日明细

贡献公式公开透明：

```
贡献分 = 新建笔记×2 + 编辑会话 + 完成任务 + floor(新增词数/100) + floor(专注分钟/25)
```

### 3. 速记（flomo 式）

- 右侧栏五个页签：**全部 / 回顾 / 漫步 / 标签 / 沉淀**
- 全部：输入（支持粘贴图片，自动存进附件目录）、搜索、`#标签` 筛选、`Ctrl/Cmd+Enter` 提交
- 回顾：每日回顾（按日期稳定选出几条）+ 去年今日 + 上月今日
- 漫步：按本地相似度（中文双字 / 英文词 / 标签）串联旧速记，无联网
- 标签：标签树与计数，点击筛选
- 沉淀：按分类分组展示 Agent 写入的知识笔记与工作日志
- 「全部」页签下方直接显示「与当前笔记相关」的速记和工作日志，切换笔记自动更新
- 速记写入当天日记的 `## 速记` 段落，是普通 `> [!memo] HH:MM` Callout，离开插件也能读

### 4. 周复盘与数据分析

- 周复盘：本期/上期对比、每日明细、本期速记、「值得回看」线索，Markdown 渲染预览 + 复制按钮
- 数据分析：每日写作柱状图、写作变化折线、时间投入、写作来源（逐步写入/大段捕获）、投入去向（按目录）、活跃时段（小时 × 星期）、投入节律矩阵
- 年度画像：年轮、知识指纹、月相日历、知识地层、月报海报（可左右切月，导出 PNG）

### 5. 画风与内置番茄钟

- 三种画风：**像素湖面 / 水墨山水 / 像素城市**，页脚「换画风」或命令切换
- 横幅含天空渐变、云、光晕、远近山脊、灯塔、水面倒影与颗粒质感；天体随时段沿弧线更新，夜间按月相显示月亮
- 底部地平线：山脊是近期每日贡献，湖面倒影、季节树、今天的小旗，专注时出现帆船
- 番茄钟：25/5/15 分钟，状态栏倒计时，完成才把 25 分钟记入 `focusMinutes`

### 6. 待办模块

- 扫描 vault 原生 `- [ ]` 待办，不另存一份数据
- 分「今日 / 遗留（逾期）/ Agent」展示，点标题打开原笔记
- 通过 `delegate_task` 把待办转成 `#to-agent` 速记，速记会记住 `sourcePath`/`sourceLine`，可一键跳回原复选框并定位行号
- 命令「记录今日遗留待办到日记」按需写入，不默认修改笔记

### 7. Agent 能力

- **本地 HTTP API**：只监听 `127.0.0.1:27123`，令牌鉴权
- **MCP stdio 桥接**：`mcp-server/index.mjs`，31 个工具
- **一键配置**：插件设置页自动探测本机智能体客户端，勾选后写入 MCP 配置（自动备份原文件）
- **智能工作流**：`get_daily_context` 返回 `agentTasks`（`#to-agent` 未完成项），`claim_agent_task` → `complete_agent_task` 形成闭环
- **安全护栏**：文件夹/标签黑名单，`sediment_status: draft` 草稿标记，调用审计日志
- 详见下方「Agent 接入」章节

### 8. 数据备份、主题适配与嵌入

- **data.json 库内备份**：定期把统计快照写入 `sediment-backup/`，避免 `.obsidian` 被 Git / 同步工具忽略；可设置保留份数
- **Style Settings**：在 Style Settings 里可视化调节卡片圆角、内边距、正文字号、热力图格子尺寸
- **代码块嵌入**：在 Home.md 写 ```sediment-heatmap```（支持 `metric:` / `weeks:` 参数）或 ```sediment-today```，直接嵌入图表与今日快照
- **富 Tooltip 与连击徽章**：悬停热力图格子预览当天笔记标题与速记摘要，显示当前 / 最长连续天数
- **分享卡**：速记卡片 hover 出操作栏（复制 / 分享图 / 转 Agent）；支持极简 / 票据 / 水墨三种模板的速记分享卡与「今日战报」PNG
- **Agent 变更审查**：最近变更列表、备份 Diff 并排对比、一键恢复

---

## 二、安装

和 Crisp Pulse 一样，支持 **BRAT** 与手动安装。

### 方式一：BRAT（推荐）

1. 安装并启用 **BRAT** 插件
2. BRAT 设置 → **Add Beta plugin**
3. 输入仓库地址：`miyavis/Sediment`
4. 在「第三方插件」列表中启用 **Sediment**

### 方式二：手动安装

1. 从 [Releases](https://github.com/miyavis/Sediment/releases) 下载最新的 `main.js`、`manifest.json`、`styles.css`
2. 进入 vault 的 `.obsidian/plugins/`，新建文件夹 `sediment` 并放入三个文件
3. 设置 →「第三方插件」重新载入并启用

### 自己构建

```sh
npm install
npm run build      # 同步 CHANGELOG + tsc 类型检查 + esbuild 打包
npm run dev        # watch 模式
npm run test:mcp   # 检查 MCP 工具列表
```

---

## 三、命令

| 命令 | 说明 |
| --- | --- |
| 打开知识脉冲看板 | 在主区打开三段式看板 |
| 打开速记面板 | 打开右侧速记视图 |
| 记一条速记 | 弹窗快速记录 |
| 生成本周工作复盘 | 生成并打开本周复盘笔记 |
| 切换看板顶部和底部的画风 | 湖面 / 水墨 / 城市循环切换 |
| 记录今日遗留待办到日记 | 按需快照未完成待办 |
| 备份统计数据到库内 | 立即把 data.json 快照写入备份目录 |
| 导出今日战报图片 | 生成今日战报 PNG |
| 查看更新记录 | 查看 CHANGELOG |

---

## 四、设置

| 设置项 | 说明 |
| --- | --- |
| 日记文件夹 / 文件名格式 | 速记写入位置，默认 `daily/YYYY-MM-DD.md` |
| 速记段落标题 | 默认 `## 速记` |
| 每周起始日 | 周一或周日，影响周复盘与热力图 |
| 热力图默认指标 | 打开看板时默认指标 |
| 统计有效编辑会话 | 关闭后不再累计编辑会话 |
| 复盘归档文件夹 | 默认 `reviews/` |
| Agent 工作日志目录 / 知识沉淀目录 | 默认 `agent-logs/`、`knowledge/` |
| 知识库分类 | 逗号分隔，默认 `技术,项目,方法,灵感,复盘`；Agent 可传任意自定义分类 |
| Agent 禁止访问的文件夹 / 标签 | 逗号分隔，对 Agent 的读写搜全部生效 |
| 看板画风 | 湖面 / 水墨 / 城市 |
| 每日写作目标 | 默认 1000，0 关闭 |
| 自动备份统计数据 / 备份目录 / 保留份数 | 默认开启，写入 `sediment-backup/`，保留 10 份 |
| 启用本地 Agent API / 端口 / 令牌 | 服务只监听回环地址 |
| 一键配置智能体客户端 | 自动探测并写入 MCP 配置；也可复制配置 JSON |

---

## 五、Agent 接入

### 架构

```
OpenCode / Qoder / Claude Code / Cursor / ...
        │  MCP stdio
        ▼
mcp-server/index.mjs  ──HTTP──▶  Obsidian 插件内 127.0.0.1:27123
                                  │
                                  ├── vault 文件读写
                                  ├── data.json（统计 / 速记 / 日志）
                                  └── 检索、图谱、语义索引
```

三层入口共用同一套实现：

1. 插件内 API：`app.plugins.plugins["sediment"].agentApi` 或 `window.Sediment.api`
2. 本地 HTTP API：`?token=` 或 `Authorization: Bearer <token>`
3. MCP stdio 桥接：31 个工具

### 开启步骤

1. 设置 →「Agent 接入」勾选 **启用本地 Agent API**，令牌自动生成
2. 设置 →「一键配置智能体客户端」选择已探测到的客户端，点「一键配置」（自动备份原配置）
3. 重启客户端即可使用；也可点「复制配置 JSON」手动粘贴

OpenCode 配置示例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sediment": {
      "type": "local",
      "command": ["node", "D:/project/Obsidian_plugin/mcp-server/index.mjs"],
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

其它客户端使用 `command` + `args` + `env` 的等价写法即可。

> 桥接脚本用 `node:http`，兼容 Node 16+（无全局 fetch）。

### MCP 工具（31 个）

**上下文与读取**

| 工具 | 说明 |
| --- | --- |
| `get_daily_context` | 开工上下文包：今日状态、工作日志、速记、笔记、`agentTasks` |
| `get_active_context` | 当前笔记、选中文本、光标段落 |
| `get_note_metadata` | 只读 frontmatter / 标签 / 大纲 / 链接，省 Token |
| `get_graph_neighbors` | 1-hop 出链 / 反链 / 同标签笔记 |
| `search_notes` | 全文关键词搜索 |
| `semantic_search` | 本地 TF-IDF 语义检索 + 同义词扩展 |
| `list_notes` / `read_note` | 列目录 / 读全文 |
| `get_stats` / `get_today` | 每日指标 / 今日快照 |
| `get_memos` / `get_backlog` | 速记 / 未转化积压 |
| `get_pomodoro` / `get_tool_activity` | 番茄钟 / 调用统计 |
| `list_work_logs` / `list_categories` / `list_tasks` | 日志 / 分类 / 待办 |
| `generate_weekly_review` | 生成周复盘 Markdown |

**写入与沉淀**

| 工具 | 说明 |
| --- | --- |
| `create_note` / `append_note` | 新建 / 追加笔记 |
| `patch_note` | 按标题或文本片段局部修改，写前备份，支持 `ifMatch` |
| `update_frontmatter` | 单独改 frontmatter 字段 |
| `add_memo` | 记速记，可带 `sourcePath`/`sourceLine` |
| `add_knowledge` | 沉淀知识笔记，自动分类并标 `sediment_status: draft` |
| `record_work_log` | 记录一次工作会话 |
| `control_pomodoro` | start/pause/reset/skip/toggle |
| `complete_task` / `delegate_task` / `snapshot_tasks` | 勾选待办 / 转 Agent 任务 / 遗留快照 |
| `claim_agent_task` / `complete_agent_task` | 认领 / 完成 `#to-agent` 任务 |

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health`、`/today`、`/stats?days=`、`/activity` | 状态与统计 |
| GET | `/notes`、`/search`、`/note`、`/note-metadata`、`/semantic-search`、`/graph` | 检索与读取 |
| POST | `/note`、`/patch-note`、`/frontmatter` | 写入与局部修改 |
| POST | `/memo`、`/knowledge`、`/worklog` | 速记 / 知识 / 工作日志 |
| GET | `/context`、`/review`、`/worklogs`、`/memos`、`/backlog`、`/categories` | 上下文与列表 |
| GET | `/active-context`、`/pomodoro`、`/tasks` | 活跃上下文 / 番茄 / 待办 |
| POST | `/pomodoro`、`/tasks/complete`、`/tasks/delegate`、`/tasks/snapshot` | 控制与任务 |
| POST | `/agent-task/claim`、`/agent-task/complete` | 任务闭环 |

### URL 快速捕捉

```
obsidian://sediment?action=memo&text=一个想法&tags=灵感,阅读
obsidian://sediment?action=dashboard
```

> 安全：服务只绑定回环地址、令牌必填；黑名单目录/标签对 Agent 不可见；不开启就不监听端口。

---

## 六、让智能体沉淀每天的工作

vault 根目录的 `AGENTS.md` 已写好三阶段协议：

1. **开工对齐**：`get_daily_context` + `get_active_context`，提醒 `agentTasks`
2. **精准读写**：先 `semantic_search` / `get_graph_neighbors` / `get_note_metadata` 探索，再用 `patch_note` 局部修改，严禁覆写长文
3. **收工沉淀**：`record_work_log`，价值结论用 `add_knowledge`，`#to-agent` 待办用 `claim` / `complete` 闭环

`#to-agent` 任务的生命周期：

```
记速记 #to-agent  →  get_daily_context 返回 agentTasks
   →  claim_agent_task  (#agent-in-progress)
   →  complete_agent_task(id, resultPath)  (#agent-done)
```

AI 生成的知识笔记默认 `sediment_status: draft`，在「智能体工坊」里可**采纳并归档 / 合并到关联笔记 / 驳回删除**。

---

## 七、数据格式

数据保存在 `.obsidian/plugins/sediment/data.json`：

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
      "contribution": 10,
      "hourlyWords": [0, 0, 12],
      "capturedWords": 0,
      "folderWords": { "knowledge": 530 },
      "activeMinutes": 25,
      "aiWordsAdded": 480
    }
  },
  "memos": [
    {
      "id": "lxx...",
      "date": "2026-11-19",
      "time": "14:05",
      "text": "调研一下 MCP",
      "tags": ["to-agent"],
      "converted": false,
      "sourcePath": "daily/2026-11-18.md",
      "sourceLine": 12
    }
  ],
  "workLogs": [],
  "toolCalls": [],
  "settings": {}
}
```

---

## 八、项目结构

```
.
├── src/
│   ├── main.ts                  # 入口、命令、视图注册
│   ├── types.ts                 # 数据模型与默认值
│   ├── data/store.ts            # data.json 读写与防抖
│   ├── tracking/tracker.ts      # 写作统计
│   ├── features/                # 速记 / 复盘 / 番茄钟 / 待办
│   ├── agent/                   # API、HTTP 服务、语义检索、一键配置
│   ├── ui/                      # 设置页、弹窗、更新记录
│   ├── views/                   # 看板与速记视图
│   └── utils/                   # 日期与路径
├── mcp-server/index.mjs         # MCP stdio 桥接
├── scripts/                     # CHANGELOG 同步与发布说明生成
├── CHANGELOG.md
├── styles.css
├── manifest.json
├── esbuild.config.mjs
└── .github/workflows/           # CI 与 Release 自动上传
```

---

## 九、版本与发布

- 变更记录统一写在 `CHANGELOG.md`，按版本分「新增 / 变更 / 修复」
- 构建时自动同步进插件，看板「更新记录」和 GitHub Release 正文都来自它
- 发布流程由维护者决定：**平时只提交代码，不升版本**；决定发布时只升尾号（如 `0.8.2` → `0.8.3`），打 tag 后 `.github/workflows/release.yml` 自动构建并上传三个文件
- 什么时候升 0.9 / 1.0 由维护者决定

---

## 十、已知边界

- 没有授权系统，全部功能免费开放
- 没有语音/ASR、没有 Crisp Focus / Tempo / Annotations 原生联动
- 语义搜索是本地 TF-IDF + 同义词扩展，不是大型 embedding 模型
- 双色热力图按 `aiWordsAdded` 占比着色，在「新增词数」指标下最明显
- 风格切换目前主要影响顶部横幅，底部地平线保持统一场景
- 移动端可用基础功能，Agent API 需要桌面版

---

## 许可

MIT © miyavis <miyavis521@gmail.com>
