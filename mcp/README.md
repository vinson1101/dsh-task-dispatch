# dsh-relay-mcp

把 [`dsh-session-relay`](../dsh-session-relay) 的本地 HTTP 接口包成 MCP 工具，让 Codex（或任何 MCP 客户端）能直接给一个真实的 DSH 会话派活。

零依赖，只用 Node 内置模块和全局 `fetch`（Node >= 18）。

## 六个工具

| 工具 | 作用 |
|---|---|
| `dsh_send` | 在指定工作空间派活，立刻返回 `taskId` |
| `dsh_ask` | 派活并等待；超时返回 `running` + `taskId`，不重发 |
| `dsh_result` | 按 `taskId` 只读查结果，不触发模型 |
| `dsh_wait` | 等待任务最终状态，超时不取消、不重发 |
| `dsh_sessions` | 列出会话（含休眠），带类型与可投递原因 |
| `dsh_workspaces` | 列出已注册的工作空间 |

**目标用 `workspace`（项目绝对路径），不用记 session id**：该目录下已有会话就复用，没有就自动新建。

## 前置条件

1. DSH 正在运行
2. `dsh-session-relay` 插件已启用（默认监听 `127.0.0.1:7391`）

## 注册到 Codex

```bash
codex mcp add dsh -- /opt/homebrew/bin/node /绝对路径/dsh-relay-mcp/index.mjs
codex mcp list   # 确认出现 dsh
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_RELAY_URL` | `http://127.0.0.1:7391` | 中继地址 |
| `DSH_RELAY_TOKEN` | 无 | 中继设置了 token 时填 |

注册时带上：

```bash
codex mcp add dsh --env DSH_RELAY_URL=http://127.0.0.1:7391 -- /opt/homebrew/bin/node /绝对路径/index.mjs
```

## 关于审批

Codex 对 MCP 工具调用默认要审批：

- **交互式**（Codex App）：第一次调用会弹窗，允许即可
- **`codex exec` / 脚本**：`approval_policy = never` 时会直接拒绝，需要
  `--dangerously-bypass-approvals-and-sandbox`，或在 `~/.codex/config.toml` 里调整审批策略

## 协议说明

stdio 传输，每条 JSON-RPC 消息一行。支持 `initialize` / `tools/list` / `tools/call` / `ping`。
stdout 只写协议消息，不写日志——日志会污染协议流。

## License

MIT
