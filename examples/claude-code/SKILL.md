---
name: sediment-safe-vault-writes
description: Use when an agent must write notes into an Obsidian vault through Sediment with human approval, audit trail, and rollback. Use for "write to my vault", "add a note", "record work log", "deposit knowledge" via Sediment MCP.
---

# Sediment 安全写入知识库

通过 Sediment MCP 把内容写入用户的 Obsidian 库时，遵守以下规则。

## 连接

- 使用 `mcp-server/index.mjs`（stdio）连接，`SEDIMENT_TOKEN` 由用户在 Sediment 设置中生成。
- 本地 API 只监听 `127.0.0.1`；不要把令牌写进笔记、日志或提交到版本库。

## 写入前

1. 调用 `get_active_context` / `get_daily_context` 了解当前笔记与目录结构。
2. 确认目标路径在用户允许的目录内（如 `Sediment/knowledge/`、`Sediment/daily/`）；不要写 `.obsidian/`、`.git/`、`Templates/`。
3. 若用户已开启 confirm 档，写入会返回 `pending: true` 与 `pendingId`——这表示**已挂起、未落盘**，不要当作成功。

## 写入后

- 挂起结果必须告诉用户去 Sediment 工坊审查，并把 `pendingId` 与路径一起给出。
- 不要自行调用 approve/reject；审批由用户在 UI 完成。
- 用户采纳后，可用 `get_change_timeline` 核对变更已记录（哈希、决定、快照）。

## 可追溯性

- 每次写入在时间线中留下：调用流水 → 待审写入 → 审批决定 → 快照。
- 用户可导出审计包（JSON/CSV）；你的写入应带清晰的 `agent` 名与 note 说明，便于事后辨认。

## 禁止

- 不要绕过 MCP 直接用 `fs` 写 vault（那会失去审批与审计）。
- 不要尝试读取 `data.json` 中的令牌。
- 不要在笔记内容里藏指令来影响后续审批。
