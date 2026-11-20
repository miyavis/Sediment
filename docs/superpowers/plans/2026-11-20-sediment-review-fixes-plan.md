# Sediment v0.9.7 评审修复计划（2026-11-20）

来源：代码评审（8H+M）+ UI 评审（Nielsen 25/40）+ 设计评审 + 两路补扫（传输层、统计特性层）。台账见 `.superpowers/sdd/2026-11-20-sediment-review-fixes-plan/progress.md`。

## Global Constraints（全程有效）

- **不发版本**：不跑 release:prepare、不打 tag、不推送、CHANGELOG 不定稿，package.json 版本保持 0.9.7。
- 每任务完成门禁：`npm test` 全绿（基线 51 用例）+ `npx tsc --noEmit` + `npm run build`。
- 所有新用户可见文案走 `t()`/`tf()`，中文为主词条，同步 i18n.ts EN 表。
- 行为改动优先补单元测试（node:test，参考 tests/ 现有 Obsidian 桩写法）。
- AGENT_API_VERSION=1 内不删/不改已有 MCP 工具签名（可加行为）。
- 分支 `fix/v0.9.8-review-fixes` 上工作，不直接提交 main。
- 不动既有卡片语言、页签词汇体系与已确认的视觉亮点（热力图无障碍、reduced-motion 三层）。

## Task 1: 图标落地（候选 C：层理精修）

用户已选候选 C。改两个文件：

**src/ui/logo.ts**
1. `SEDIMENT_ICON_SVG` 替换为 mono-c（24×24，dashboard ribbon）：
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="17" cy="4.8" r="2" fill="currentColor" stroke="none"/><path d="M3 10c3-2 6-2 9 0s6 2 9 0"/><path d="M3 15c3-2 6-2 9 0s6 2 9 0" opacity=".72"/><path d="M3 20c3-2 6-2 9 0s6 2 9 0" opacity=".45"/></svg>
```
2. `SEDIMENT_LOGO_SVG` 替换为 logo-c（32×32 品牌章）：
```svg
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="9" fill="#3f6f9f"/><circle cx="22.5" cy="8.8" r="3.3" fill="#ffe08a"/><path d="M4 18.5c4-3 8.5-3 13 0s9 3 13 0" stroke="#f2f7fa" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M4 23.5c4-2.6 8.5-2.6 13 0s9 2.6 13 0" stroke="#c8d9e6" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".9"/><path d="M4 28c4-2.2 8.5-2.2 13 0s9 2.2 13 0" stroke="#a3bdd2" stroke-width="3" fill="none" stroke-linecap="round" opacity=".75"/></svg>
```
3. 新增导出 `SEDIMENT_MEMO_ICON_ID = "sediment-memo"` 与 `SEDIMENT_MEMO_ICON_SVG`（mono-memo 便签，速记 ribbon 专用）：
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 4.5h14V15l-4.5 4.5H5z"/><path d="M14.5 19.5V15H19"/><path d="M8.5 9.5h7M8.5 13h4.5"/></svg>
```
（先读文件，保持现有代码风格与常量命名方式；若现有 SVG 字符串不带 xmlns 且构建正常，保持一致即可。）

**src/main.ts**
- :19 import 增加 `SEDIMENT_MEMO_ICON_ID, SEDIMENT_MEMO_ICON_SVG`。
- :38 `addIcon(SEDIMENT_ICON_ID, SEDIMENT_ICON_SVG)` 后新增一行 `addIcon(SEDIMENT_MEMO_ICON_ID, SEDIMENT_MEMO_ICON_SVG)`。
- :109 速记 ribbon 改用 `SEDIMENT_MEMO_ICON_ID`（看板 ribbon 保持 `SEDIMENT_ICON_ID`）。

验收：build 通过；用户在 Obsidian 重载后看 ribbon 两图标可区分、设置页品牌章为新徽标。

## Task 2: UI P0 快修（深色主题 + 触屏 + 移动端承诺）

1. **styles.css:498-524**：`.sd-tab/.sd-refresh/.sd-range/.sd-metric-tab` 的 `background: rgba(255,255,255,0.86)` 改为 `var(--background-secondary)`；检查 sd-brand（styles.css:472-483 附近，白字叠 rgba(22,38,62,.42)）底色改 `color-mix(in srgb, var(--interactive-accent) 55%, var(--background-primary))`。改后核对激活态（is-active 用 --interactive-accent）在深浅主题下的对比度。
2. **styles.css:1814-1825**：`.sd-memo-actions` 增加 `@media (hover: none) { .sd-memo-actions, .sd-memo-card:hover .sd-memo-actions, .sd-draft-card:hover .sd-memo-actions { opacity: 1; } }`（触屏直接可见）。
3. **移动端**：src/main.ts 与 src/views 引入 `Platform.isMobile`（obsidian 模块导出）：移动端 TABS 过滤掉 agent 页签（dashboard-view.ts 的 TABS 循环处），insights 子导航隐藏 folders/yearly 两项（insights.ts:22-29 附近）。实现方式自选最小侵入（如 view 内 `if (Platform.isMobile)` 过滤）。
4. **styles.css:427** 删除指向从未生成的 `.sd-insights-secondary` 死规则（先 grep 确认无 TS 引用再删）。

验收：build + test 通过；用户窄窗口/手机真机看导航可读、速记操作按钮可见。

## Task 3: 权限统一门禁（H6/H7/M1/M3 + 传输层 M）

统一以 src/agent/access.ts 为唯一规则源。

1. **H6**（api.ts:815-860 附近）：completeTask/delegateTask/snapshotTasks/revertAgentChange 补权限检查——按各操作的 path 归属走 isOperationAllowed/isPathDenied 等既有函数；拒绝时返回与现有拒绝路径一致的错误结构（先读现有 denial 返回格式再对齐）。
2. **H7**（semantic.ts:81-97）：检索/读取结果逐条过 `isPathAllowedByMode`（或现有白名单判定函数），白名单对语义检索生效。
3. **M1**（api.ts:950-958）：addKnowledge 的 category 清洗：拒绝包含 `/`、`\`、`..` 的值（trim 后校验），非法值回退默认分类并在返回信息中说明。
4. **M3**（access.ts:49）：agentAccessMode 非 denylist/allowlist 枚举值时 fail-closed（按最严模式处理）。
5. **server.ts:111**：令牌比较改恒定时间——`crypto.timingSafeEqual`（先对两侧做 SHA-256 定长哈希再比较，避免长度不等抛异常）。
6. **单测**：access.ts 现有覆盖缺口补齐——全角逗号分隔、allow-all 分支、create/overwrite/delete 操作矩阵；以上 5 项修复各至少 1 条行为断言（H7 用语义检索过滤的单测或最小桩测试）。

## Task 4: confirm 工作模式真实现（D1=A）

现状：agentWorkMode 四档（readonly/draft/confirm/auto）中 confirm 只有设置项与文案（settings-tab.ts:210-239、agent.ts:135），无拦截逻辑。

实现语义：confirm 档下，Agent 的**写路径**（api.ts 中 write_note/patch_note/add_memo/add_knowledge 等落盘操作）不直接写，而是：
1. 生成待审条目（目标 path + 新内容/patch + 时间），存入 store（新字段如 `pendingWrites`，带数据版本兼容——读 data.json 旧格式时缺字段要有默认值）；
2. 现有变更审查卡（agent.ts renderAgentChanges）或新卡展示待审项，点击走 DiffModal 预览，「采纳」才真正落盘（复用现有写入函数），「驳回」丢弃；采纳/驳回后从 pendingWrites 移除；
3. readonly 档：写路径直接拒绝（现状保持）；draft 档：add_knowledge/add_memo 可写（草稿流），其余写拒绝（现状语义保持，若现状未区分则以 README 描述为准）；auto 档：现状行为。
4. 写路径拒绝时错误信息明确说明"confirm 模式下已挂起待审"或"readonly 模式拒绝写入"。
5. 单测：四档矩阵至少覆盖 confirm 挂起/采纳落盘/驳回丢弃、readonly 拒绝。
6. UI 侧在 agent 页签的挂起列表要显示总数（后续 Task 7 会重排页签，此处先可用即可）。

注意与 Task 3 的门禁顺序：权限检查 → confirm 拦截 → 快照 → 落盘。Task 3 先行，本任务在其接口之上。

## Task 5: 存储层可靠性（2A）

1. **store.ts:78-92（最重）**：days/memos 等结构性损坏（字段存在但类型/形状异常）不再静默重置——走与版本守卫相同的 preserveRecoveryCopy + 阻塞写入路径，Notice 告知用户恢复副本位置。
2. **store.ts:161-166**：backupFolder 为库根目录或空串时禁用备份清理逻辑（只备份不清理）。
3. **store.ts:63-69（L）**：data.json 无 version 字段时给出升级路径——按 v1 数据形状尝试迁移并写回 version，失败才阻塞。
4. **H1**（store.ts:141）：save() 包 try/catch，失败时 Notice 提示 + console.error（若 Task 10 已建日志封装则用它，注意任务顺序，本任务先用 console.error + Notice）。
5. **H2**（store.ts:149-150）：lastBackupAt 移到备份成功写入之后更新。
6. **H3**（store.ts:136）：persistenceBlocked 时启动阶段 Notice 一次（带恢复副本路径说明），避免静默丢写。
7. **H4**：backupData 的 catch 不再吞错——传播给调用方（main.ts 备份命令已有 Notice 路径，确认错误能到达用户）。
8. **单测**：结构损坏走恢复副本、备份清理禁用条件、save 失败不静默——各至少 1 条。

接口预留：Task 7 需要的"恢复数据 UI"依赖本任务提供 store 级恢复能力（列出 sediment-backup/ 快照 + 从快照恢复），本任务实现该 API（可复用 features/audit.ts 的 listBackups/readBackup 模式，注意那是笔记快照，数据恢复对象是 data.json 备份），带单测。

## Task 6: 统计与特性正确性（2B）

1. **tracker.ts:141-144,206-212（M）**：人机判定——Agent 抑制期内暂缓基线更新，窗口结束后按实际 diff 补计，Agent 写后 10s 内人的编辑不再被吞。
2. **tracker.ts:146-153,209（M）**：无基线文件只建基线不计分（prev 按 {0,0} 的整篇误计修复）。
3. **pomodoro.ts:36,110-117（M）**：计时改 timestamp 基准，tick 按 `Date.now() - startedAt` 换算 remaining（含暂停语义）。
4. **pomodoro.ts:47-54,119-141（M）**：补记归属实际完成日期而非"今天"；加载时单实例检测（如 data.json 内写入实例标识 + 心跳，检测到另一存活实例则本实例番茄功能禁用并 Notice）。
5. **memo.ts:105-155（M）**：callout 匹配加 id 锚点兜底（frontmatter 或行内 id），edit 先匹配后改；失配时 Notice 明确提示"未找到日记中对应条目"而非静默；删除失配时不再留孤儿 callout（尽力按旧文本清理，失败则提示）。
6. **main.ts:363-366（M）**：generateReview 周复盘去重——文件已含本周区间标题则跳过（Notice"本周复盘已存在"）。
7. **单测**：以上各 1 条行为断言（tracker 用时间窗可注入的桩；pomodoro 可注入 clock；memo 用现有 Obsidian 桩）。

## Task 7: 页签契约与设置 IA（D2=B：Agent 页签收窄为审核队列）

前置：Task 5 的数据恢复 API 已存在。

1. **Agent 页签**（views/dashboard/sections/agent.ts）：保留 AI 沉淀审核、Agent 变更审查、数据快照恢复（新卡：列出 data.json 备份快照 + 一键恢复，调 Task 5 API）；移除智能体工作日志卡与连接状态卡（挪到今日页）；待办卡只渲染 `source === "agent"` 子集（或等价过滤）。
2. **今日页**（today.ts）：接收工作日志卡 + 连接状态卡（renderWorkLogs/renderAgentStatus 调用迁移）；删除独立"开始专注"按钮（today.ts:29-35），保留今日卡内番茄 toggle 单一入口。
3. **页签徽章**：dashboard-view.ts 页签渲染处，Agent 页签标题带待审数量徽章（草稿数 + 变更数 + 待审写入数之和；为 0 不显示）。
4. **renderFooter** 上移到 dashboard-view.ts render() 统一调用（移除 agent.ts:18、insights.ts:57 处的调用），今日页也有页脚。
5. **设置面板**（settings-tab.ts）：加「基础」分区标题（覆盖前 14 项）；Agent 目录/黑名单 5 项（:132-196）移入 Agent 区（:198 起）；工作模式下拉变更时 `window.confirm` 提示将重置 5 个权限开关（:210-239）；权重输入 onChange 加 300ms 防抖（:447-451）；「允许删除」死开关（:306-314）删除并从 i18n 清词条。
6. agent.ts 草稿截断（slice(0,20)）时卡头显示"共 N 份草稿"。
7. 全程保持 i18n 同步；本任务改动大，views 内保持 section 模块结构不回灌 dashboard-view.ts。

## Task 8: i18n 与图表可访问性（P2-1/P2-2）

1. **t() 补齐**：src/ui/diff-modal.ts（:89/:94 等）、diagnostics-modal.ts、mcp-uninstall-modal.ts、main.ts:213/:218 两个命令名——中文词条进 i18n.ts ZH 与 EN 双表。
2. **CI 防再犯**：scripts/ 下新增检查（可并入 verify-release 或独立脚本）：扫描 src 内 `createEl/createDiv/createSpan` 字面量中文未被 t() 包裹的违规（白名单机制允许注释/测试），挂进 package.json test 链或 test:release。
3. **图表**：utils/charts.ts multiLineSvg 增加 series 标签参数，insights.ts:331-338 调用处传入（新增/删除/捕获图例：色点+文字，DOM 层实现即可）；charts.ts 各 SVG 输出加 `role="img"` 与 aria-label（汇总关键数值）；insights.ts:229-234 删除热力图格子原生 title（自定义 tooltip 已覆盖）。

## Task 9: 层积剖面主视图（D3=B）

「知识地层」页签主视图升级：人/AI/任务/专注按月堆叠成地层横截面（时间轴纵深=月份），GitHub 式热力图降为附属（保留但不再居中）。

1. 数据：store/tracker 现有 humanWrites/agentWrites + tasks 完成数 + focusSessions 按月聚合；缺聚合函数则新增（纯函数，可单测）。
2. 视图：insights.ts 新增 renderStrata（替换或前置现有 renderHeatmap 调用位置），SVG 或 DOM 均可，遵循 Task 8 的 a11y 约定（role/aria-label/图例）；沿用地层视觉语言（层块+透明度节奏，参考 styles.css 既有 .sd-strata-* 死样式的意图——本任务实现后删除该死样式组）。
3. 双主题校验；深浅主题下各层可辨。
4. `renderHeatmap` 的 dual 参数死分支（insights.ts:46/149/225-239）由剖面取代——移除 dual 参数与人/AI 图例死代码；i18n「人机双色热力图」词条随之清理。
5. 单测：月度聚合函数。

## Task 10: 清理与加固（批次 7 打包）

1. **openTaskSource 去重**（dashboard-view.ts:337 / agent.ts:95，留一处）。
2. **死样式清理**：.sd-strata-*（Task 9 已处理则跳过）、.sd-summary、.sd-detail-grid、.sd-analytics-list——逐组 grep 确认零引用后删；styles.css 四代叠写本轮只删死样式，不做整代重排。
3. **Riley 组**：memo 长文本行数钳制（-webkit-line-clamp 或 max-height+展开）、任务完成按钮 confirm 期间禁用防双击（dashboard-view.ts:311-317）、backupKeep 静默回退加 Notice（settings-tab.ts:351-359）、poster-modal.ts:75-78 画布色改 CSS 变量读取（getComputedStyle 取主题变量，fallback 保留浅色）。
4. **Alex 组**：quick-memo-modal.ts 支持 Ctrl+Enter 提交、空文本点保存 Notice 提示（:36-44）、换画风改直选下拉或菜单（dashboard-view.ts:441-447，menu 用 Obsidian Menu）。
5. **传输路 L 项**：server.ts:109 移除 ?token= 查询串支持（只留 Authorization 头；若 MCP 桥依赖查询串需同步改 bridge-source.ts）；server.ts:90/331 超限改 413 ApiError、500 白名单化 error.message；server.ts:107 new URL() 包 try 返回 400；index.mjs/bridge-source.ts 加 HTTP 超时（如 30s）与响应体上限、stdin 缓冲上限、畸形 JSON 记诊断后断开；MCP 桥区分"令牌缺失"提示。
6. **杂项**：sticky 53px 改 CSS 变量；PosterModal 跨年月份循环（poster-modal.ts:35-41）；诊断日志 slice 提示"还有更多"；i18n EN 表清理已删命令词条；main.ts:228 命令名措辞修正（"切换看板画风"）。
7. **日志封装**：最小 logError 工具（console.error + 追加 diagnostics 列表，带上限如 200 条），替换关键 catch 点的静默吞错（store/api/server/pomodoro）。
8. **verify-release.mjs**：加两行断言——README.md 含 `version-v${manifest.version}` 徽章；versions.json 含 `${manifest.version}` 键。
9. **README/CHANGELOG 事实修正**：CHANGELOG 中"~1300 行降到 ~410 行"改实际（dashboard-view.ts 现 448 行）、"14 个命令"改 16 个；README 移动端描述与 Task 2 实现对齐。
10. **.gitignore**：追加 `.impeccable/`。
11. **docs/design/icon-candidates.html** 纳入版本控制（git add）。

## Final Review

全部任务后：review-package 全分支 diff → 最强模型整体审查 → 单轮修复 → 收尾汇报（含全部 Ruling 清单）。
