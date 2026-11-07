# dsh-session-relay · 会话中继

按 **session id** 给一个真实的 DSH 会话投递消息，并（可选）同步等它回话。

它解决的是"两个 AI 之间靠人肉复制粘贴传话"的问题：Codex、脚本、CI 只要会发 HTTP，就能把任务丢进某个正在跑的 DSH 会话，再把结论取回去。

**零依赖**：不声明任何 `@deepseek-ai/*` 或第三方包，只用 Node 内置模块和宿主已有的 `sessionController` / `agents` / `sessions` 服务。

---

## 为什么不用现成的

社区已有的 `hermes-dsh-bridge` 功能更全，但截至 0.11.4，它把所有 `@deepseek-ai/*` 依赖钉在 `^0.1.2-rc.1`，在 DSH 0.2.x 上会装进第二份同名包，导致宿主加载错版本（实测会崩，并把 profile 的配置层重置成空）。

本插件刻意不依赖任何宿主包，因此**不会**出现这种冲突。代价是它只做"投递 + 等待"这一件事，不做文件工具、审批桥、预设管理。

## 安装

```bash
# 本地目录（开发时）
dsh plugin --profile desktop add /绝对路径/dsh-session-relay

# 或发布到 npm 之后
dsh plugin --profile desktop add dsh-session-relay@latest
```

安装后重启 DSH，日志里会出现：

```
[dsh-session-relay] 已就绪 http://127.0.0.1:7391
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只接受回环地址，填别的会启动失败 |
| `port` | `7391` | 监听端口 |
| `token` | 无 | 设置后所有请求需带 `Authorization: Bearer <token>` |

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

- 默认只监听 `127.0.0.1`，代码里硬性拒绝非回环地址
- 同一台机器上的任何进程都能调用，**对外暴露前务必设置 `token`**
- 它能驱动真实的 agent，也就意味着能间接执行命令、改文件——当成本机 shell 级别的权限对待

## 已知限制

- `/sessions` 只列**活跃**会话；冷会话不会出现，但知道 id 仍然可以直接 `/send`
- `/ask` 一次只等一轮；长任务请用 `/send` + 轮询，或把 `timeoutMs` 调大
- 不提供流式输出，只返回这一轮的最终正文

## License

MIT
