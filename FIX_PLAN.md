# Sediment 修正计划（全量）

> 来源：整体审查（架构 / AI 闭环 / 功能 UI / 工程质量）。
> 决策：D1 鸡肋功能收进「实验性功能」默认关闭；D2 接受统计口径变更并写明；D3 下一版 1.1.0；D4 真正启用 `idempotencyKey` / `redactSecrets`；D5 删除 grep 伪测试、换行为测试。
> 执行顺序：A → B → C。每完成一项勾选并注明版本/验证结果。

## 阶段 0 · 决策

- [x] D1 鸡肋功能收进实验性分区，默认关闭（阶段 3 执行）
- [x] D2 接受统计口径变更，CHANGELOG 写明（阶段 3 执行）
- [x] D3 下一版 1.1.0
- [x] D4 启用 `idempotencyKey` / `redactSecrets`（阶段 4 执行）
- [x] D5 删除 grep 伪测试，换行为测试（阶段 4 执行）

## 阶段 1 · P0 正确性（A 批）

- [x] 1.1 审批预览与落盘绑定：`PendingWriteRecord.beforeHash`，`holdForConfirm` 计算，`approvePendingWrite` 重读校验，`modify` 事件纳入失效（`src/utils/hash.ts`、`api.ts`、`store.ts`、`main.ts`、i18n；新增 CONTENT_CHANGED 测试）
- [x] 1.2 并发上下文隔离 + 原子采纳：`WriteMeta` 增 `tool/call`，删除单例上下文，server 每次请求构造 `callMeta`；`approvePendingWrite` 用 in-flight Set 防双采纳（新增并发测试）
- [x] 1.3 Store 串行化 / 重试 / 恢复取消在途：save/backup 双 promise 链、3 次退避重试、`flush()`、备份文件名加秒/毫秒/随机后缀、恢复前 `flush()`（新增串行化与重试测试）
- [x] 1.4 服务启停竞争：`applySettings` promise 链串行；`stop()` 用 `closeAllConnections()`；`onunload` 改 async 并 await 关闭与冲刷
- [x] 1.5 无备份审核行可结案：`sections/agent.ts` 无备份分支也渲染「标记已审查」
- [x] 1.6 审计只记有效写请求：GET 不记；错误响应（401/400/413/404/500）撤回审计行（新增 HTTP 测试）
- [x] 1.7 门禁缺口：`claim/completeAgentTask` 接 confirm；`addKnowledge` 最终路径过 `safeAgentPath`；`replayPending` 运行时校验参数并补 meta

## 阶段 2 · P1 性能（B 批）

- [x] 2.1 今日页三次全库扫合并为一次：`TaskManager.listGrouped()` 单次扫描分组，看板改调用它（新增"各文件只读一次"测试）
- [x] 2.2 Agent 页 2~3 次全库遍历合并：新增 `views/dashboard/scan-cache.ts`，徽章 / 草稿卡 / 来源未登记卡 / 知识现状卡共用一次 render 内的扫描
- [x] 2.3 `audit.ts` 新增 `listBackupsMap`，审核列表一次目录列举服务全部行，消除逐行同步 IO
- [x] 2.4 自动刷新加输入中守卫（不打断打字）+ 防抖 400→1000ms；手动刷新仍全量（点名：并非完全取消重绘，属折中）
- [x] 2.5 语义索引失效节流：embedding 失败重试每分钟最多一次，索引仍惰性重建

## 阶段 3 · P2 产品与统计（C 批）

- [x] 3.1 鸡肋功能收进「实验性功能」设置分区，默认关闭：月相 / 漫步 / 海报 / 多画风（含设置开关与渲染门禁）
- [x] 3.2 统计诚实化：指标 hint、封顶提示、活跃时间估算说明、地层来源归属说明、日均按有记录天数计算（与周复盘同口径）
- [x] 3.3 UI 一致性：按钮改名区分、「刷新」→「重绘看板」、草稿采纳加二次确认
- [x] 3.4 a11y：热力图 grid role=row、tooltip Escape 关闭 + 缓存、地层命中区 role=button、tablist、sd-strata aria
- [x] 3.5 移动端：洞察子导航不再隐藏入口（插件本身桌面专用，Agent 页签保留隐藏）

## 阶段 4 · P3 工程质量（C 批）

- [x] 4.1 删除 7 处源码 grep 伪测试；补行为测试：并发采纳、跨重启重放、内容变更拒绝、门禁逃逸、Store 串行化/重试、单次全库扫描
- [x] 4.2 发布链路收口：release.yml tag 加引号、版本正则锚定结尾、verify-release 增加标签白名单/package-lock/versions value/dist 一致性、CI 加 verify-release + dirty-tree、Node 统一 22
- [x] 4.3 tsconfig 开 `strict: true`、新增 `tsconfig.tests.json` + `npm run test:typecheck`、引入 ESLint/stylelint 配置与 CI 步骤、删除 `typed<T>` 万能断言
- [x] 4.4 文档一致性：两份 README 的 API 兼容承诺与 build/test 说明、CHANGELOG Node 版本、新增 Unreleased 变更条目

## 验收记录

| 批次 | 版本 | 验证 |
|---|---|---|
| A | 未发布（当前版本仍 1.0.11，留待 1.1.0 统一发布） | `npm test` 226/226、`npm run build`、`npm run test:release -- 1.0.11` 全绿；含 5 个新增行为测试 |
| B | 未发布（随 A/C 统一到 1.1.0） | `npm test` 227/227、`tsc --noEmit` 全绿；新增单次全库扫描测试 |
| C | 未发布（随 1.1.0 统一发布） | `npm test` 221/221、`test:typecheck`、`lint:eslint`、`lint:stylelint`、`build`、`test:release -- 1.0.11` 全绿 |
