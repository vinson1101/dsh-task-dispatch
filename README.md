# dsh-task-dispatch

Deliver a message to a real DSH session **by session id**, and optionally wait for its reply.

It removes the human copy-paste relay between two agents: Codex, a script, or CI only needs HTTP to hand a task to a running DSH session and read the answer back.

**Zero dependencies.** It declares no `@deepseek-ai/*` or third-party packages — only Node built-ins plus the host's existing `sessionController` / `agents` / `sessions` services.

---

## Why not the existing bridge

`hermes-dsh-bridge` is broader, but as of 0.11.4 every `@deepseek-ai/*` dependency is pinned to `^0.1.2-rc.1`. On DSH 0.2.x that installs a second copy of the same packages, the host loads the wrong version (observed: boot failure that also reset the profile's patch layer), and the plugin never runs.

This plugin deliberately declares no host packages, so that class of conflict cannot happen. The trade-off: it only sends and waits — no file tools, approval bridge, or preset management.

## Use from Codex (MCP)

The plugin only speaks HTTP. To expose it as Codex tools, use the bundled `mcp/` adapter:

```bash
codex mcp add dsh -- node /absolute/path/dsh-task-dispatch/mcp/index.mjs
codex mcp list
```

Codex then gets `dsh_send` / `dsh_ask` / `dsh_result` / `dsh_wait` / `dsh_tasks` / `dsh_sessions` / `dsh_workspaces`.

## Install

**Not published to npm yet.** Install from GitHub:

```bash
# Option 1: the packed artifact from a release (recommended)
dsh plugin --profile desktop add https://github.com/vinson1101/dsh-task-dispatch/releases/download/v0.6.0/dsh-task-dispatch-0.6.0.tgz

# Option 2: straight from git (pulls mcp/ and test/ too)
dsh plugin --profile desktop add github:vinson1101/dsh-task-dispatch

# Option 3: a local directory (development; symlinked, edits apply immediately)
dsh plugin --profile desktop add /absolute/path/dsh-task-dispatch
```

Restart DSH afterwards; the log shows:

```
[dsh-task-dispatch] ready http://127.0.0.1:7391
```

### 30-second check

```bash
curl -s http://127.0.0.1:7391/health
# {"ok":true,"name":"dsh-task-dispatch","version":"0.6.0",...}

curl -s -X POST http://127.0.0.1:7391/send \
  -H 'content-type: application/json' \
  -d '{"workspace":"/your/project","text":"reply with the single word: ok"}'

curl -s http://127.0.0.1:7391/tasks/<taskId-from-the-previous-call>
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Loopback only; any other value fails activation |
| `port` | `7391` | Listen port |
| `token` | none | When set, requests need `Authorization: Bearer <token>` |

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe, no token |
| `GET` | `/sessions` | List **live** sessions (id / cwd / title / running) |
| `POST` | `/send` | Deliver a message, return immediately (202) |
| `POST` | `/ask` | Deliver, wait for the turn, return assistant text |

### `POST /send`

```json
{ "sessionId": "session-23af063e-...", "text": "run the tests", "mode": "steer" }
```

- `sessionId` required; cold sessions are resumed automatically
- `mode` optional, `steer` interrupts instead of queueing
- Returns `{ ok, sessionId, requestId, afterSeq }`

### `POST /ask`

```json
{ "sessionId": "session-23af063e-...", "text": "done yet?", "timeoutMs": 120000 }
```

- Same as `/send` plus waiting; returns `{ ok, reason, text, truncated }`
- `reason`: `idle` / `input-required` / `timeout`
- `text` is extracted from this turn's `assistant/message` events
- `timeoutMs` defaults to 120000

## Use from Codex

```bash
curl -s -X POST http://127.0.0.1:7391/send \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-23af063e-...","text":"check the task status"}'
```

Wrap that curl in an MCP server if you want Codex to call it as a tool.

## Security

**Authentication is required by default.** On first start the plugin generates a 32-byte token, writes it to `$DSH_HOME/relay/token` (mode `600`) and reuses it across restarts. Every endpoint except `/health` needs it:

```bash
curl -H "Authorization: Bearer $(cat ~/.dsh/relay/token)" http://127.0.0.1:7391/tasks
```

Request validation, enforced in code:

| Check | Behaviour | Blocks |
|---|---|---|
| `Host` must be `127.0.0.1` / `localhost` / `[::1]` | else 403 | DNS rebinding |
| A present `Origin` must be local | else 403 | malicious web pages |
| `POST` must use `content-type: application/json` | else 415 | simple-form CSRF |

- Binds loopback only; a non-loopback host throws at activation
- Disabling auth requires an explicit `allowAnonymous: true` (logs a warning) and is **not recommended**
- It drives a real agent, i.e. local shell-level access — do not expose the port to a LAN

## Limitations

- `/sessions` lists live sessions only; a cold session still accepts `/send` if you know its id
- `/ask` waits for one turn; for long work use `/send` plus polling, or raise `timeoutMs`
- No streaming; only the turn's final text is returned

## License

MIT
