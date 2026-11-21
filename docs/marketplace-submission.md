# Obsidian 社区市场提交清单

前置条件全部满足后再提交 PR（由维护者 miyavis 本人执行）。

## 1. 发布资产

- [ ] GitHub Release 附带三个资产：`main.js`、`manifest.json`、`styles.css`（来自 `dist/`，release 工作流已自动上传）。
- [ ] `manifest.json` 的 `version` 与 release tag 一致，`versions.json` 含该版本与 `minAppVersion` 映射。
- [ ] `manifest.json` 的 `description` 为英文（市场展示用）。
- [ ] 仓库根有 `LICENSE`（MIT）。

## 2. 仓库与文档

- [ ] 仓库公开、README 顶部有英文概述。
- [ ] 生成内容在 EN locale 下零 CJK（单测已断言：周复盘、知识笔记、工作日志、健康任务、检索标题）。

## 3. 审核要点披露（写进 PR 描述，减少来回）

- [ ] 本地 HTTP Agent API：默认关闭，仅监听 `127.0.0.1`，需用户手动开启（含 token）。
- [ ] Ollama embedding：默认关闭（TF-IDF 为默认），仅请求本机回环地址，不可用时自动回退，不访问外网。
- [ ] 无遥测、无云端上传。
- [ ] 所有 Agent 写操作受工作模式门禁（只读/草稿/确认后写入/自动）。

## 4. PR 条目

向 `obsidianmd/obsidian-releases` 的 `community-plugins.json` 追加（保持文件现有排序约定）：

```json
{
  "id": "sediment",
  "name": "Sediment",
  "author": "miyavis",
  "description": "Local-first knowledge dashboard with heatmaps, quick memos, weekly reviews, and agent knowledge deposition via MCP.",
  "repo": "miyavis/Sediment"
}
```

## 5. 提交后

- [ ] 跟进机器人检查（manifest 校验、资产可下载）。
- [ ] 审核意见涉及功能调整时，回仓库走正常发版流程（本清单不替代发版 SOP）。
