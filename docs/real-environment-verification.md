# 真实环境验证手册（数据可靠性 / Agent 安全 / 性能）

本文给维护者在**真实 Obsidian 环境**里验证 v0.9.0 之后补齐的能力。所有操作都在本地完成，不需要上传任何笔记。

## 0. 准备

1. 切换到开发分支并确保是最新代码：

   ```sh
   git switch improvement/ci-regression-coverage
   git pull
   npm install
   npm run build
   npm test
   npm run test:bench
   ```

2. 让 Obsidian 用上这版代码（二选一）：
   - 发布版：等维护者发布后通过 BRAT 更新；
   - 本地预览：把仓库根目录的 `main.js`、`manifest.json`、`styles.css` 复制到
     `<vault>/.obsidian/plugins/sediment/`，重启 Obsidian。

3. 打开诊断入口：Obsidian 命令面板 → **查看诊断日志**。
   日志也保存在 `<vault>/.obsidian/plugins/sediment/data.json` 的 `diagnostics` 字段，最多 300 条。

> 诊断日志只记录事件类型、时间、消息和脱敏后的路径，**不含令牌或笔记正文**。

---

## 1. 数据可靠性（对应清单第 2 项）

### 1.1 未知版本保护与恢复副本

**步骤**

1. 先手工备份：复制 `<vault>/.obsidian/plugins/sediment/data.json` 到别处。
2. 用文本编辑器打开 `data.json`，把顶层 `"version": 1` 改成 `"version": 99`，保存。
3. 重启 Obsidian。
4. 打开命令面板 → **查看诊断日志**。

**预期**

- 看板/设置显示警告：不支持的数据版本 99，已暂停写入以保护原始数据。
- 诊断日志出现一条 `migration` 事件，消息含「不支持的数据版本 99」，`detail` 给出恢复副本路径，例如：
  `.obsidian/plugins/sediment/recovery/data-2026-11-20T...json`
- 该恢复副本文件内容与第 1 步备份一致。
- 此时修改笔记不会写回 `data.json`（插件已暂停持久化）。

**恢复**

1. 把 `data.json` 的 `version` 改回 `1`（或用第 1 步备份覆盖）。
2. 重启 Obsidian，警告消失，数据完整。

### 1.2 数据格式损坏保护

**步骤**

1. 备份 `data.json`。
2. 把顶层 `days` 对象改成数组：`"days": []`，保存。
3. 重启 Obsidian，查看诊断日志。

**预期**

- 加载不报错，插件不会静默覆盖原文件。
- 诊断日志出现 `migration` 或 `storage` 事件；数据被规范化为空，但原始文件仍保留恢复副本。

### 1.3 大批量历史数据规范化

已有自动化单测：400 天含负数、字符串、null 的历史数据规范化（`npm test` 中「Store.load：大批量历史数据规范化且不重复计数」）。

**手工加测（建议在测试库，不要动主库）**

1. 新建一个 Obsidian 测试库，安装同一插件。
2. 在该库生成 `data.json`，`days` 里放 400 天记录，部分 `wordsAdded` 为负数、`hourlyWords` 含字符串/null、`folderWords` 为 null。
3. 重启，确认看板正常打开、贡献分按当前权重重算、`hourlyWords` 长度 24。

---

## 2. Agent/MCP 安全（对应清单第 3 项）

### 2.1 鉴权失败

**步骤**

在终端执行（令牌随便写一个错的）：

```sh
curl "http://127.0.0.1:27123/health?token=wrong-token"
```

**预期**

- HTTP 状态码 `401`，响应 `{"error":"unauthorized"}`。
- 诊断日志出现 `security` 事件「本地 API 鉴权失败」，detail 含来源 IP 与脱敏后的路径。

### 2.2 工作模式限制写入

**步骤**

1. 插件设置 → Agent 工作模式选 **只读**。
2. 在 Qoder / OpenCode 里让 Agent 调用 `write_note` 或 `patch_note` 修改任意笔记。

**预期**

- Agent 收到 `OPERATION_DENIED` 类错误，写入未发生。
- 诊断日志出现 `security` 事件「操作 overwrite/patch/create 被工作模式拒绝」。

完成后把模式改回原来的设置。

### 2.3 黑名单目录与标签

**步骤**

1. 设置 →「Agent 禁止访问的文件夹」填一个目录名，例如 `MyDocs`。
2. 让 Agent 调用 `read_note` 读取该目录下任意 `.md`。

**预期**

- 返回 403 / FORBIDDEN，诊断日志记录「访问被拒绝：… 位于黑名单目录」。
- 搜索结果也不再包含该目录文件。

标签黑名单同理：设置 forbidden tag 后，带该标签的笔记对 Agent 不可读。

### 2.4 系统目录硬拦截

**步骤**

让 Agent 尝试读取 `.obsidian/plugins/sediment/data.json` 或 `.git/config`。

**预期**

- 返回 FORBIDDEN；诊断日志记录拒绝原因。
- 无法通过改白名单绕过（这是硬编码拦截）。

### 2.5 审计脱敏

诊断日志和工具调用记录里的路径不应包含 `?token=...` 之类的查询串。可查看 `data.json` 的 `toolCalls` / `diagnostics` 字段核对。

单元回归：`npm test` 中「审计脱敏：路径去掉查询串，已知令牌被替换」。

> 已知边界：幂等键 `idempotencyKey` 已实现并单测，但 HTTP 层尚未对重复请求强制去重。真实并发重试目前只能观察是否产生重复文件；如发现重复，请记录复现步骤，后续版本再加服务端去重。

---

## 3. 性能（对应清单第 4 项）

### 3.1 纯函数基准

```sh
npm run test:bench
```

参考结果（本机）：

```
days=1000   elapsed=0.6ms   heapDelta=0.07MB
days=10000  elapsed=2.4ms   heapDelta=0.51MB
days=100000 elapsed=15.7ms  heapDelta≈0MB
```

这是贡献分计算的纯函数基准，用于发现明显退化，不代表完整 Obsidian 渲染耗时。

### 3.2 真实看板计时（手工）

1. 打开一个**小型库**（笔记 < 100 篇），记录：
   - 打开看板到内容可见的时间；
   - 热力图点某天到明细出现的时间；
   - 运行一次 `search_notes` 的往返时间。
2. 换一个**较大型库**（笔记 > 1000 篇）重复。
3. 若语义检索耗时超过 80ms，诊断日志会出现 `performance` 事件「语义检索耗时 Nms」，可据此对比索引规模与耗时。

### 3.3 资源观察

- Obsidian 命令面板 → 开发者工具（若可用）→ Performance / Memory，录制一次看板打开与搜索。
- 关注：监听是否有重复注册（插件停用/重载后不应残留本地 API 端口占用）。
- 验证方法：停用再启用插件，然后运行 `curl http://127.0.0.1:27123/health?token=<你的令牌>`，应能正常返回；再停用，端口应释放。

---

## 4. 已忽略 / 已完成项

- **移动端**：按你的要求忽略，不做真机验收。
- **kp-* / sd-***：已统一为 `sd-*` 前缀，全量构建与 41 例单测通过。

## 5. 结果记录建议

把每次验证结果追加到知识库笔记「Sediment 待办推进清单」的「真实环境验证记录」小节，格式：

```
- 2026-11-20 数据可靠性：未知版本保护 ✅，恢复副本路径 ...，版本改回后数据完整
- 2026-11-20 安全：鉴权失败 401 + 诊断日志 ✅；只读模式拒绝写入 ✅
- 2026-11-20 性能：小库打开看板 ~0.3s，大库 ~1.2s；语义检索未出现 >80ms 诊断
```
