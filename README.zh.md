# dsh-task-dispatch · 任务派发

按 **session id** 给一个真实的 DSH 会话投递消息，并（可选）同步等它回话。

它解决的是"两个 AI 之间靠人肉复制粘贴传话"的问题：Codex、脚本、CI 只要会发 HTTP，就能把任务丢进某个正在跑的 DSH 会话，再把结论取回去。

**零依赖**：不声明任何 `@deepseek-ai/*` 或第三方包，只用 Node 内置模块和宿主已有的 `sessionController` / `agents` / `sessions` 服务。

---

## 为什么不用现成的

社区已有的 `hermes-dsh-bridge` 功能更全，但截至 0.11.4，它把所有 `@deepseek-ai/*` 依赖钉在 `^0.1.2-rc.1`，在 DSH 0.2.x 上会装进第二份同名包，导致宿主加载错版本（实测会崩，并把 profile 的配置层重置成空）。

本插件刻意不依赖任何宿主包，因此**不会**出现这种冲突。代价是它只做"投递 + 等待"这一件事，不做文件工具、审批桥、预设管理。

## 给 Codex 用（MCP）

插件只提供 HTTP 接口。要让 Codex 直接当工具调用，用仓库内的 `mcp/` 适配层：

```bash
codex mcp add dsh -- node /绝对路径/dsh-task-dispatch/mcp/index.mjs
codex mcp list
```

> 升级插件后，**MCP 适配层也要同步更新并重启**（Codex 会为每个新会话重新拉起它）。适配层需要读到与中继相同的 `$DSH_HOME/relay/token`，旧版适配层不认识令牌，会直接 401。

之后 Codex 里就有 `dsh_send` / `dsh_ask` / `dsh_result` / `dsh_wait` / `dsh_tasks` / `dsh_sessions` / `dsh_workspaces`。

## 安装

**尚未发布到 npm**，从 GitHub 安装：

```bash
# 方式一：release 里的打包文件（推荐，等价于正式包）
dsh plugin --profile desktop add https://github.com/vinson1101/dsh-task-dispatch/releases/download/v0.6.2/dsh-task-dispatch-0.6.2.tgz

# 方式二：直接从 git 仓库安装（会带上 mcp/ 和 test/，体积略大）
dsh plugin --profile desktop add github:vinson1101/dsh-task-dispatch

# 方式三：本地目录（开发时，软链，改代码即时生效）
dsh plugin --profile desktop add /绝对路径/dsh-task-dispatch
```

安装后重启 DSH，日志里出现：

```
[dsh-task-dispatch] 已就绪 http://127.0.0.1:7391
```

### 30 秒验证

```bash
curl -s http://127.0.0.1:7391/health
# {"ok":true,"name":"dsh-task-dispatch","version":"0.6.2",...}

curl -s -X POST http://127.0.0.1:7391/send \
  -H 'content-type: application/json' \
  -d '{"workspace":"/你的项目路径","text":"只回复两个字：收到"}'

curl -s http://127.0.0.1:7391/tasks/<上一步返回的 taskId>
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只接受回环地址，填别的会启动失败 |
| `port` | `7391` | 监听端口 |
| `token` | **自动生成** | 首次启动生成并写入 `$DSH_HOME/relay/token`（600）；手工指定则以此为准。详见「安全」 |

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/health` | 存活检查，无需 token |
| `GET` | `/workspaces` | 列出已注册的工作空间（项目目录） |
| `GET` | `/sessions` | 列出会话，**含休眠会话**；支持 `?cwd=` 与 `?query=` |
| `POST` | `/send` | 派工，立刻返回 `taskId`（202） |
| `POST` | `/ask` | 派工并等待；超时返回 `status: running` 与 `taskId`，不重发 |
| `GET` | `/tasks` | 任务列表，可按 `sessionId` / `workspace` / `status` 过滤 |
| `GET` | `/tasks/:id` | 只读查询单个任务，不触发模型 |
| `POST` | `/wait` | 等待任务状态变化，超时不取消、不重发 |

任务记录持久化在 `$DSH_HOME/relay/tasks/<taskId>.json`，中继重启后仍可查询。
完成状态按「本次投递之后的 turn 段」归属，不看会话是否空闲；拿不到事件区间时 `attribution` 会标为 `unavailable`，不会假装成功。

### 投给谁：工作空间优先

`/send` 和 `/ask` 接受 `workspace`（项目目录的绝对路径）**或** `sessionId`，二选一：

- 给 `workspace`：该目录下已有会话就复用（优先运行中的），没有就**自动新建一个**并挂到同名工作空间
- 给 `sessionId`：精确投递到那个会话（休眠的会被唤醒）

日常应该用 `workspace`——session id 是实现细节，工作空间才是稳定的目标。

### `POST /send`

```json
{ "workspace": "/Users/me/Projects/my-app", "text": "把 tests/ 跑一遍" }
```

- `workspace` 与 `sessionId` 二选一，必填其一
- `mode` 可选，`steer` 表示插话而不是排队
- 返回 `{ ok, sessionId, created, workspace, requestId, afterSeq }`，`created: true` 表示这次新建了会话

### `POST /ask`

```json
{ "sessionId": "session-23af063e-...", "text": "跑完了吗？", "timeoutMs": 120000 }
```

- 在 `/send` 的基础上等待，返回 `{ ok, reason, text, truncated }`
- `reason` 是停止原因：`idle` / `input-required` / `timeout`
- `text` 是从本轮 `assistant/message` 里抽出的正文
- `timeoutMs` 默认 120000

## 在 Codex 里用

```bash
curl -s -X POST http://127.0.0.1:7391/send \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-23af063e-...","text":"检查一下这个任务的状态"}'
```

想让 Codex 像用工具一样用，可以把这个 curl 包成 MCP server，或者直接让它在终端里跑。

## 安全

**默认必须认证。** 首次启动会自动生成一个 32 字节令牌，写入 `$DSH_HOME/relay/token`（权限 `600`），重启复用同一令牌。除 `/health` 外的所有接口都需要：

```bash
curl -H "Authorization: Bearer $(cat ~/.dsh/relay/token)" http://127.0.0.1:7391/tasks
```

请求校验（都在代码里强制）：

| 校验 | 行为 | 挡什么 |
|---|---|---|
| `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]` | 否则 403 | DNS rebinding |
| 带 `Origin` 时必须来自本机 | 否则 403 | 恶意网页跨站请求 |
| `POST` 必须 `content-type: application/json` | 否则 415 | 简单表单 CSRF |

- 只监听回环地址，非回环在启动时直接抛错
- 想关掉认证必须显式写 `allowAnonymous: true`（会打警告日志），**不建议**
- 它能驱动真实 agent，等于本机 shell 级权限，别把端口暴露到局域网

## 数据目录

任务台账默认落在 `$DSH_HOME/relay/tasks/`（沿用旧目录名，保证升级后历史任务仍可查）。

## 回传：目前**不支持**主动回调

这是当前最重要的一条限制，写在这里避免误解：

- 任务结束后，中继**不会**主动把结果推回调用方会话。MCP 的 server→client 通知能不能唤醒一个正在等结果的 Codex 会话，尚未验证，也没有实现。
- `notify` 字段只是**待办记录**：`unsupported`（没有配置渠道）、`pending`/`sending`（正在重试）、`sent`/`failed`（webhook 结果）。它代表"中继尝试过 HTTP 回调"，不代表"调用方已经收到并开始处理"。
- 取结果的正确方式是调用方**主动查询**：`GET /tasks/:id` 或 `dsh_result`；或长轮询 `POST /wait` / `dsh_wait`。二者都不会重发任务。
- 配置了 `notifyUrl` 时，中继会 POST 一个 JSON 到该地址（带 `idempotency-key: taskId`），失败重试 3 次，重启后继续重试。这只是"外部回调"，不是 MCP 通知。

## 已知限制

- `/sessions` 只列**活跃**会话；冷会话不会出现，但知道 id 仍然可以直接 `/send`
- `/ask` 一次只等一轮；长任务请用 `/send` + 轮询，或把 `timeoutMs` 调大
- 不提供流式输出，只返回这一轮的最终正文

## License

MIT
