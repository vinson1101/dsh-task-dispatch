/**
 * dsh-session-relay — 按「工作空间」或 session id 给真实 DSH 会话派活，
 * 并提供任务的持久记录、只读结果查询、等待与完成通知待办。
 *
 * 设计约束：零依赖。只用 Node 内置模块 + 宿主已有的服务。
 * 会话归属只用宿主字段（origin / parentSessionId / archivedSessionIds），不猜 id。
 *
 * 任务归属：结果按「我们投递的那条 user 消息之后的 turn 段」切分，
 * 而不是「会话空闲了就算完成」。
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const VERSION = '0.6.3'
const NAME = 'dsh-task-dispatch'
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_WAIT_MS = 120_000
const DEFAULT_MAX_MESSAGES = 20
const TERMINAL = new Set(['completed', 'failed'])
const NOTIFY_ATTEMPTS = 3
/** 归属连续失败多少次后转「待人工」，避免无限重试，也避免把不知道当成完成。 */
const ATTRIBUTION_ATTEMPTS = 15

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function failure(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra === undefined ? {} : { details: extra }) } }
}

function httpError(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.details = details
  return error
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw httpError(413, 'body-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'bad-request', '请求体必须是 JSON 对象')
  }
  return parsed
}

export function assistantText(records) {
  if (!Array.isArray(records)) return ''
  const parts = []
  for (const record of records) {
    const event = record?.event
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * 把结果归属到「包含我们这条 user 消息的那一个 turn」。
 *
 * 真实事件顺序是：agent/inbox/spliced → turn/start → … → user/message → assistant/message → turn/end。
 * turn 比 user 消息先开始，所以不能用「消息之后的第一个 turn/start」，
 * 必须取 seq ≤ ourSeq 的最后一个 turn/start。
 */
export function attributeTurn(events, ourSeq) {
  const sorted = [...events]
    .filter((event) => typeof event?.seq === 'number')
    .sort((left, right) => left.seq - right.seq)

  const startsBefore = sorted.filter((event) => event.type === 'turn/start' && event.seq <= ourSeq)
  const turnStart = startsBefore.at(-1)
  if (turnStart === undefined) return undefined

  const after = sorted.filter((event) => event.seq > ourSeq)
  const nextStart = after.find((event) => event.type === 'turn/start')
  const turnEnd = after.find(
    (event) => event.type === 'turn/end' && (nextStart === undefined || event.seq < nextStart.seq),
  )

  // 终止证据：这个 turn 自己的 turn/end，或确实开始了下一个 turn
  const finished = turnEnd !== undefined || nextStart !== undefined
  const endSeq = turnEnd?.seq ?? nextStart?.seq
  const segment = after.filter((event) => endSeq === undefined || event.seq <= endSeq)

  return { startSeq: turnStart.seq, endSeq, events: segment, finished }
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 7391)
  const host = String(config.host ?? '127.0.0.1')
  const tickMs = Number.isInteger(config.tickMs) && config.tickMs > 0 ? config.tickMs : 2000
  const notifyUrl =
    typeof config.notifyUrl === 'string' && config.notifyUrl.trim() !== '' ? config.notifyUrl.trim() : undefined
  const allowAnonymous = config.allowAnonymous === true
  const dataDir =
    typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
      ? config.dataDir.trim()
      : path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'relay', 'tasks')
  const tokenFile = path.join(path.dirname(dataDir), 'token')

  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`${NAME}: host 只能是回环地址，收到 "${host}"`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${NAME}: 端口非法`)

  /**
   * 令牌解析：显式配置优先；否则读 token 文件；都没有就生成一个并落盘。
   * 默认必须认证——早期版本无认证是安全缺陷，这里不再允许。
   */
  const token = (() => {
    if (typeof config.token === 'string' && config.token.trim() !== '') return config.token.trim()
    if (allowAnonymous) return undefined
    try {
      const existing = readFileSync(tokenFile, 'utf8').trim()
      if (existing !== '') {
        // 已有文件可能由更早的版本或手工创建，权限过宽就收紧
        try {
          if ((statSync(tokenFile).mode & 0o077) !== 0) {
            chmodSync(tokenFile, 0o600)
            console.warn(`[${NAME}] 令牌文件权限过宽，已收紧为 600: ${tokenFile}`)
          }
        } catch {
          // 收紧失败不影响使用，但保持可见
        }
        return existing
      }
    } catch {
      // 文件不存在，继续生成
    }
    const generated = randomBytes(32).toString('hex')
    try {
      mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
      writeFileSync(tokenFile, `${generated}\n`, { mode: 0o600 })
      console.log(`[${NAME}] 已生成访问令牌: ${tokenFile}（权限 600）`)
    } catch (error) {
      console.error(
        `[${NAME}] 无法写入令牌文件 ${tokenFile}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return generated
  })()

  if (token === undefined) {
    console.warn(`[${NAME}] 警告：allowAnonymous 已开启，本机任何进程都可调用本服务`)
  }

  /** taskId → task */
  const tasks = new Map()
  /** sessionId → Set(taskId) 仍在排队/运行的任务 */
  const pending = new Map()
  /** workspace 路径 → 最近一次成功投递的主会话 */
  const bindings = new Map()
  /** 等待中的长轮询：taskId → Set(resolve) */
  const waiters = new Map()

  function requireSessionController() {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      throw httpError(503, 'controller-unavailable', `${NAME}: 宿主没有 sessionController 服务`)
    }
    return controller
  }

  function requireString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw httpError(400, 'bad-request', `字段 ${field} 必须是非空字符串`)
    }
    return value
  }

  function authorized(req) {
    if (token === undefined) return true
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return supplied.byteLength === expected.byteLength && supplied.equals(expected)
  }

  /**
   * Host 必须是回环地址。浏览器发起跨站请求时无法自由伪造 Host，
   * 这条能挡住 DNS rebinding：恶意域名解析到 127.0.0.1 也过不了。
   */
  function hostAllowed(req) {
    const raw = req.headers.host
    if (typeof raw !== 'string') return false
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(raw)
  }

  /** 浏览器会自动带 Origin；非本机来源一律拒绝，命令行客户端不带 Origin 则放行。 */
  function originAllowed(req) {
    const origin = req.headers.origin
    if (origin === undefined) return true
    try {
      const url = new URL(origin)
      return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    } catch {
      return false
    }
  }

  /** POST 必须声明 JSON：普通表单无法设置该 Content-Type，挡掉简单表单 CSRF。 */
  function contentTypeAllowed(req) {
    if (req.method !== 'POST') return true
    const raw = req.headers['content-type']
    if (typeof raw !== 'string') return false
    // 精确匹配媒体类型，忽略 charset 等参数；application/jsonp 之类不放行
    return raw.split(';')[0].trim().toLowerCase() === 'application/json'
  }

  function archivedIds() {
    const registry = ctx.get('workspaceRegistry')
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? new Set(ids) : new Set()
  }

  function classify(row, archived) {
    const sessionId = row?.sessionId
    const reasons = []
    if (row?.origin === 'subagent' || row?.parentSessionId !== undefined) {
      reasons.push('子代理会话：由父会话拥有，不能直接接收外部消息')
    }
    if (archived.has(sessionId)) reasons.push('已归档会话')
    if (row?.formatStatus === 'migration-required') reasons.push('会话格式待迁移：需要先在 GUI 里打开一次')
    if (row?.cwd === undefined) reasons.push('会话缺少工作目录')
    return {
      kind: row?.origin === 'subagent' || row?.parentSessionId !== undefined ? 'subagent' : 'main',
      deliverable: reasons.length === 0,
      reason: reasons[0],
      reasons,
    }
  }

  async function rawRows() {
    const controller = ctx.get('sessionController')
    if (typeof controller?.list === 'function') {
      try {
        const value = await controller.list({}, new AbortController().signal)
        if (Array.isArray(value?.items)) return value.items
      } catch {
        // 退化到 agents.list()
      }
    }
    const agents = ctx.get('agents')
    return (typeof agents?.list === 'function' ? agents.list() : [])
      .filter((agent) => typeof agent?.id === 'string')
      .map((agent) => ({
        sessionId: agent.id,
        cwd: agent?.session?.header?.cwd,
        origin: agent?.session?.header?.origin,
        parentSessionId: agent?.session?.header?.parentSession,
        running: agent?.status === 'running',
      }))
  }

  async function titleOf(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.stat !== 'function') return undefined
    try {
      const snapshot = await persistence.stat(sessionId)
      const title = snapshot?.header?.title
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  async function listSessions({ query, cwd } = {}) {
    const archived = archivedIds()
    const live = new Map()
    const agents = ctx.get('agents')
    for (const agent of typeof agents?.list === 'function' ? agents.list() : []) {
      if (typeof agent?.id === 'string') live.set(agent.id, agent?.status === 'running')
    }
    const needle = query === undefined ? undefined : query.toLowerCase()
    const out = []
    for (const row of await rawRows()) {
      const sessionId = row?.sessionId
      if (typeof sessionId !== 'string') continue
      if (cwd !== undefined && row?.cwd !== cwd) continue
      const title = await titleOf(sessionId)
      if (needle !== undefined && !(title ?? '').toLowerCase().includes(needle)) continue
      const info = classify(row, archived)
      out.push({
        sessionId,
        kind: info.kind,
        deliverable: info.deliverable,
        ...(info.reason === undefined ? {} : { reason: info.reason }),
        ...(info.reasons.length > 1 ? { reasons: info.reasons } : {}),
        running: row?.running === true || live.get(sessionId) === true,
        ...(row?.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(title === undefined ? {} : { title }),
        ...(row?.origin === undefined ? {} : { origin: row.origin }),
        ...(row?.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
        ...(archived.has(sessionId) ? { archived: true } : {}),
        ...(typeof row?.updatedAt === 'number' ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}),
      })
    }
    return out
  }

  // ---------- 任务持久化 ----------

  async function ensureDir() {
    await fs.mkdir(dataDir, { recursive: true })
  }

  function taskFile(taskId) {
    return path.join(dataDir, `${taskId}.json`)
  }

  async function persist(task) {
    const file = taskFile(task.taskId)
    // 每次写用独立临时文件，避免重叠 tick / 重叠写入互相踩
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify(task, null, 2), 'utf8')
    await fs.rename(temp, file)
  }

  async function loadTasks() {
    try {
      await ensureDir()
      const names = await fs.readdir(dataDir)
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(dataDir, name), 'utf8')
          const task = JSON.parse(raw)
          if (typeof task?.taskId !== 'string') continue
          tasks.set(task.taskId, task)

          if (!TERMINAL.has(task.status) && task.status !== 'awaiting-user') {
            if (task.status === 'queued') {
              // 中继在「已投递」与「已落 running」之间崩溃：用稳定 requestId 判定，绝不自动重发
              if (await findDelivered(task)) {
                task.status = 'running'
                markPending(task)
              } else {
                task.status = 'unknown'
                task.error = {
                  code: 'unknown-delivery',
                  message: '中继在投递途中重启，无法确认宿主是否已接收；为安全起见不自动重发',
                }
              }
              await persist(task)
            } else {
              markPending(task)
            }
          }

          // 通知待办独立恢复：任务早已 completed，但通知可能还没发出去
          if (task.notify?.state !== 'sent' && task.notify?.state !== 'unsupported') {
            queueNotify(task)
          }
        } catch {
          // 单个坏文件不影响启动
        }
      }
    } catch {
      // 没有数据目录也算正常
    }
  }

  function markPending(task) {
    const set = pending.get(task.sessionId) ?? new Set()
    set.add(task.taskId)
    pending.set(task.sessionId, set)
  }

  function unmarkPending(task) {
    const set = pending.get(task.sessionId)
    if (set === undefined) return
    set.delete(task.taskId)
    if (set.size === 0) pending.delete(task.sessionId)
  }

  async function patchTask(task, changes) {
    Object.assign(task, changes, { updatedAt: new Date().toISOString() })
    if (TERMINAL.has(task.status) || task.status === 'awaiting-user' || task.status === 'timeout') {
      unmarkPending(task)
    }
    await persist(task)
    const listeners = waiters.get(task.taskId)
    if (listeners !== undefined && changes.status !== undefined) {
      for (const resolve of listeners) resolve(task)
      waiters.delete(task.taskId)
    }
    return task
  }

  // ---------- 交付信息 ----------

  async function gitInfo(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null
    try {
      const [branch, head] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }),
        execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 5000 }),
      ])
      return { branch: String(branch.stdout).trim(), headSha: String(head.stdout).trim() }
    } catch {
      return null
    }
  }

  // ---------- 结果归属 ----------

  /**
   * 向后翻页读取 (fromSeq, toSeq]。
   *
   * 宿主 history.paginate 的 beforeSeq 是「向过去翻页的排他上界」
   * （end = min(throughSeq + 1, beforeSeq)），所以取一页后要把上界收到本页最早 seq，
   * 直到覆盖到 fromSeq，不能只取一次 200 条就声称完整。
   */
  async function readWindow(sessionId, fromSeq, toSeq) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.events !== 'function') throw new Error('宿主没有 events 接口')
    const collected = []
    let upper = toSeq + 1
    for (let page = 0; page < 40; page += 1) {
      const value = await controller.events(
        {
          address: { kind: 'session', sessionId },
          throughSeq: toSeq,
          beforeSeq: upper,
          maxMessages: 200,
        },
        new AbortController().signal,
      )
      const events = (value?.records ?? []).map((record) => record?.event).filter(Boolean)
      if (events.length === 0) return { events: collected, truncated: false }
      collected.unshift(...events)
      const firstSeq = events[0]?.seq
      if (!Number.isFinite(firstSeq) || firstSeq <= fromSeq + 1) {
        return { events: collected, truncated: false }
      }
      if (value?.hasMore !== true) return { events: collected, truncated: true }
      upper = firstSeq
    }
    return { events: collected, truncated: true }
  }

  /** 用稳定 requestId 判断这条任务是否真的进了会话，用于崩溃恢复，绝不重发。 */
  async function findDelivered(task) {
    const state = await safeState(task.sessionId)
    const cursor = typeof state?.cursor === 'number' ? state.cursor : undefined
    if (cursor === undefined || !Number.isFinite(task.afterSeq)) return false
    try {
      const window = await readWindow(task.sessionId, task.afterSeq, cursor)
      return window.events.some(
        (event) => event.type === 'user/message' && event.data?.source?.rpcId === task.requestId,
      )
    } catch {
      return false
    }
  }

  /**
   * 判定任务是否真的结束，并取回属于它的正文。
   * 归属优先用 requestId 找到我们那条 user 消息，再按 turn 边界切段。
   */
  async function readTaskResult(task, state) {
    const cursor = typeof state?.cursor === 'number' ? state.cursor : undefined
    if (cursor === undefined) return { kind: 'pending', note: '拿不到会话游标' }
    if (!Number.isFinite(task.afterSeq)) {
      return { kind: 'pending', note: '缺少投递位置 afterSeq' }
    }

    let window
    try {
      window = await readWindow(task.sessionId, task.afterSeq, cursor)
    } catch (error) {
      return { kind: 'pending', note: `读取事件失败: ${error instanceof Error ? error.message : String(error)}` }
    }

    const events = window.events
    const ours = events.find(
      (event) => event.type === 'user/message' && event.data?.source?.rpcId === task.requestId,
    )
    const attribution = ours === undefined ? 'seq-turn-segment' : 'rpc-turn-segment'
    const ourSeq = ours?.seq ?? task.afterSeq

    const turn = attributeTurn(events, ourSeq)
    if (turn === undefined) return { kind: 'pending', attribution, note: '该任务的 turn 尚未开始' }
    if (!turn.finished) return { kind: 'pending', attribution, note: 'turn 尚未结束' }

    const text = assistantText(turn.events.map((event) => ({ event })))
    return {
      kind: 'completed',
      text,
      attribution,
      truncated: window.truncated,
      endSeq: turn.endSeq ?? cursor,
    }
  }

  async function finalizeSession(sessionId) {
    const ids = pending.get(sessionId)
    if (ids === undefined || ids.size === 0) return
    const state = await safeState(sessionId)
    // 宿主不可读 = 未知，不是完成。保持非终态，下一次 tick 再试。
    if (state === undefined) return
    // 仍在跑就等，不做任何判定。
    if (state.running === true) return

    const ordered = [...ids]
      .map((id) => tasks.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.afterSeq ?? 0) - (b.afterSeq ?? 0))

    for (const task of ordered) {
      if (TERMINAL.has(task.status) || task.status === 'awaiting-user') continue
      const outcome = await readTaskResult(task, state)

      // 没有真实终止证据就不收尾：宁可继续等，也不把「不知道」写成「已完成」。
      if (outcome.kind !== 'completed') {
        const attempts = (task.attributionAttempts ?? 0) + 1
        if (attempts >= ATTRIBUTION_ATTEMPTS) {
          await patchTask(task, {
            status: 'awaiting-user',
            attributionAttempts: attempts,
            attributionNote: outcome.note ?? '无法确认任务终止证据',
            error: {
              code: 'attribution-unavailable',
              message: '无法把结果归属到该任务，需要人工确认；未自动重发',
            },
          })
          queueNotify(task)
        } else {
          await patchTask(task, { attributionAttempts: attempts, attributionNote: outcome.note })
        }
        continue
      }

      const delivery = await gitInfo(task.workspace)
      await patchTask(task, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        endSeq: outcome.endSeq,
        attribution: outcome.attribution,
        attributionAttempts: 0,
        result: {
          text: outcome.text,
          reason: 'idle',
          truncated: outcome.truncated,
          empty: outcome.text === '',
        },
        delivery: {
          ...(delivery ?? {}),
          tests: null,
          leftovers: null,
          note: '分支与提交为只读探测；测试结论与剩余问题需从任务正文读取',
        },
      })
      queueNotify(task)
    }
  }

  let ticking = false
  async function tick() {
    // 在途互斥：慢宿主或重叠定时器不该并发收尾同一个会话
    if (ticking) return
    ticking = true
    try {
      for (const sessionId of [...pending.keys()]) {
        try {
          await finalizeSession(sessionId)
        } catch (error) {
          console.error(
            `[${NAME}] 收尾 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      await drainNotify()
    } finally {
      ticking = false
    }
  }

  // ---------- 完成通知 ----------

  /** 通知待办与任务跟踪解耦：任务结束后仍可能没发出去，重启后必须继续。 */
  const notifyQueue = new Set()

  function queueNotify(task) {
    if (notifyUrl === undefined) {
      if (task.notify?.state !== 'unsupported') {
        void patchTask(task, { notify: { state: 'unsupported', attempts: 0 } })
      }
      return
    }
    if ((task.notify?.attempts ?? 0) >= NOTIFY_ATTEMPTS) return
    if (task.notify?.state === 'sent') return
    notifyQueue.add(task.taskId)
  }

  async function notifyOnce(task) {
    const attempts = (task.notify?.attempts ?? 0) + 1
    // 先落盘尝试次数：进程在请求途中被中断，重启后也知道已经试过几次
    await patchTask(task, { notify: { ...(task.notify ?? {}), state: 'sending', attempts } })
    try {
      const response = await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': task.taskId },
        body: JSON.stringify({
          taskId: task.taskId,
          requestId: task.requestId,
          sessionId: task.sessionId,
          workspace: task.workspace,
          status: task.status,
          attribution: task.attribution,
          result: task.result,
          delivery: task.delivery,
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error(`通知端点返回 ${String(response.status)}`)
      await patchTask(task, { notify: { state: 'sent', attempts, at: new Date().toISOString() } })
      notifyQueue.delete(task.taskId)
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error)
      if (attempts >= NOTIFY_ATTEMPTS) {
        await patchTask(task, { notify: { state: 'failed', attempts, error: lastError } })
        notifyQueue.delete(task.taskId)
      } else {
        // 保持 pending，下一次 tick 继续重试，不丢
        await patchTask(task, { notify: { state: 'pending', attempts, error: lastError } })
      }
    }
  }

  async function drainNotify() {
    for (const taskId of [...notifyQueue]) {
      const task = tasks.get(taskId)
      if (task === undefined) {
        notifyQueue.delete(taskId)
        continue
      }
      await notifyOnce(task)
    }
  }

  // ---------- 目标解析 ----------

  function pickMain(candidates, workspacePath) {
    const sorted = [...candidates].sort((left, right) => {
      const byTime = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      return byTime !== 0 ? byTime : String(left.sessionId).localeCompare(String(right.sessionId))
    })
    const boundId = bindings.get(workspacePath)
    if (boundId !== undefined) {
      const bound = sorted.find((row) => row.sessionId === boundId)
      if (bound !== undefined) return { picked: bound, rule: 'bound' }
      bindings.delete(workspacePath)
    }
    const running = sorted.find((row) => row.running === true)
    if (running !== undefined) return { picked: running, rule: 'running' }
    const engaged = sorted.find((row) => row.blank !== true)
    if (engaged !== undefined) return { picked: engaged, rule: 'recent-active' }
    if (sorted.length > 0) return { picked: sorted[0], rule: 'recent-any' }
    return { picked: undefined, rule: 'none' }
  }

  async function createMain(workspacePath) {
    const registry = ctx.get('workspaceRegistry')
    let workspaceId
    if (typeof registry?.resolveByPath === 'function') {
      try {
        const workspace = await registry.resolveByPath(workspacePath)
        if (workspace?.id !== undefined) workspaceId = workspace.id
      } catch {
        // 没有注册工作空间就按 cwd 建
      }
    }
    const controller = requireSessionController()
    const created =
      workspaceId === undefined ? await controller.create({ cwd: workspacePath }) : await controller.create({ workspaceId })
    if (typeof created?.sessionId !== 'string') {
      throw httpError(502, 'create-failed', '新建会话失败：宿主未返回 sessionId')
    }
    return created.sessionId
  }

  async function resolveTarget(body) {
    if (typeof body.sessionId === 'string' && body.sessionId.trim() !== '') {
      const sessionId = body.sessionId.trim()
      const row = (await rawRows()).find((candidate) => candidate?.sessionId === sessionId)
      if (row === undefined) throw httpError(404, 'session-not-found', `会话不存在: ${sessionId}`, { sessionId })
      const info = classify(row, archivedIds())
      if (!info.deliverable) {
        throw httpError(409, 'session-not-deliverable', `会话 ${sessionId} 不可直接投递：${info.reason}`, {
          sessionId,
          kind: info.kind,
          reason: info.reason,
        })
      }
      return { sessionId, selection: { rule: 'explicit', candidateCount: 1 } }
    }

    const workspacePath =
      typeof body.workspace === 'string' && body.workspace.trim() !== ''
        ? body.workspace.trim()
        : typeof body.cwd === 'string' && body.cwd.trim() !== ''
          ? body.cwd.trim()
          : undefined
    if (workspacePath === undefined) {
      throw httpError(400, 'bad-request', '必须提供 sessionId，或 workspace（项目目录的绝对路径）')
    }
    if (!workspacePath.startsWith('/')) {
      throw httpError(400, 'bad-request', `workspace 必须是绝对路径: ${workspacePath}`)
    }

    const rows = await listSessions({ cwd: workspacePath })
    const candidates = rows.filter((row) => row.deliverable === true && row.kind === 'main')
    const excluded = rows.length - candidates.length

    if (candidates.length === 0) {
      const sessionId = await createMain(workspacePath)
      return {
        sessionId,
        selection: { rule: 'created', candidateCount: 0, excludedCount: excluded, workspace: workspacePath },
      }
    }
    const { picked, rule } = pickMain(candidates, workspacePath)
    return {
      sessionId: picked.sessionId,
      selection: {
        rule,
        candidateCount: candidates.length,
        excludedCount: excluded,
        workspace: workspacePath,
        running: picked.running === true,
        ...(picked.title === undefined ? {} : { title: picked.title }),
      },
    }
  }

  async function safeState(sessionId) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.state !== 'function') return undefined
    try {
      return await controller.state({ sessionId }, new AbortController().signal)
    } catch {
      return undefined
    }
  }

  // ---------- 派活 ----------

  async function deliver(body, signal) {
    const text = requireString(body.text, 'text')
    const target = await resolveTarget(body)
    const requestId =
      typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : randomUUID()
    const controller = requireSessionController()

    const task = {
      taskId: `task-${randomUUID()}`,
      requestId,
      sessionId: target.sessionId,
      workspace: target.selection?.workspace ?? null,
      selection: target.selection,
      text,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      afterSeq: typeof ctx.get('sessions')?.get?.(target.sessionId)?.seq === 'number'
        ? ctx.get('sessions').get(target.sessionId).seq - 1
        : -1,
      endSeq: null,
      attribution: null,
      attributionAttempts: 0,
      result: null,
      delivery: null,
      notify: { state: 'pending', attempts: 0 },
      error: null,
    }

    // 先落盘「投递意图」：宿主已接收但中继崩溃时，重启后靠 requestId 判定，绝不自动重发
    tasks.set(task.taskId, task)
    await persist(task)

    try {
      await controller.prompt(
        { sessionId: target.sessionId, content: [{ type: 'text', text }], requestId, ...(body.mode === 'steer' ? { mode: 'steer' } : {}) },
        signal,
      )
    } catch (error) {
      if (target.selection?.workspace !== undefined) bindings.delete(target.selection.workspace)
      task.status = 'failed'
      task.finishedAt = new Date().toISOString()
      task.error = {
        code: typeof error?.code === 'string' ? error.code : 'delivery-rejected',
        message: error instanceof Error ? error.message : String(error),
      }
      await persist(task)
      throw httpError(409, 'delivery-rejected', `宿主拒绝了这次投递: ${task.error.message}`, {
        sessionId: target.sessionId,
        taskId: task.taskId,
        code: task.error.code,
      })
    }

    if (target.selection?.workspace !== undefined) bindings.set(target.selection.workspace, target.sessionId)

    const session = ctx.get('sessions')?.get?.(target.sessionId)
    if (typeof session?.seq === 'number') task.afterSeq = session.seq - 1
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    markPending(task)
    await persist(task)

    return { taskId: task.taskId, requestId, sessionId: target.sessionId, selection: target.selection, afterSeq: task.afterSeq }
  }

  // ---------- 路由 ----------

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)

    // 1) 先校验请求来源，再做任何事（包括 health）
    if (!hostAllowed(req)) {
      sendJson(res, 403, failure('host-not-allowed', 'Host 头必须是本机回环地址'))
      return
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, failure('origin-not-allowed', '拒绝来自非本机 Origin 的请求'))
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: NAME, version: VERSION, tasks: tasks.size, auth: token === undefined ? 'none' : 'token', notify: notifyUrl === undefined ? 'unsupported' : 'configured' })
      return
    }

    // 2) 认证：默认必须带 token
    if (!authorized(req)) {
      sendJson(res, 401, failure('unauthorized', '缺少或错误的 Bearer token'))
      return
    }

    // 3) POST 必须声明 JSON
    if (!contentTypeAllowed(req)) {
      sendJson(res, 415, failure('unsupported-media-type', 'POST 必须使用 content-type: application/json'))
      return
    }

    if (req.method === 'GET' && url.pathname === '/workspaces') {
      const registry = ctx.get('workspaceRegistry')
      const rows = typeof registry?.list === 'function' ? registry.list() : []
      sendJson(res, 200, {
        ok: true,
        total: rows.length,
        workspaces: rows.map((workspace) => ({ workspaceId: workspace?.id, path: workspace?.path, ...(workspace?.title === undefined ? {} : { title: workspace.title }) })),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const sessions = await listSessions({
        query: url.searchParams.get('query') ?? undefined,
        cwd: url.searchParams.get('cwd') ?? undefined,
      })
      sendJson(res, 200, { ok: true, total: sessions.length, deliverable: sessions.filter((row) => row.deliverable === true).length, sessions })
      return
    }

    if (req.method === 'GET' && url.pathname === '/tasks') {
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const workspace = url.searchParams.get('workspace') ?? undefined
      const status = url.searchParams.get('status') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 50)
      let rows = [...tasks.values()]
      if (sessionId !== undefined) rows = rows.filter((task) => task.sessionId === sessionId)
      if (workspace !== undefined) rows = rows.filter((task) => task.workspace === workspace)
      if (status !== undefined) rows = rows.filter((task) => task.status === status)
      rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      sendJson(res, 200, { ok: true, total: rows.length, tasks: rows.slice(0, Number.isFinite(limit) ? limit : 50) })
      return
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && taskMatch !== null) {
      const task = tasks.get(decodeURIComponent(taskMatch[1]))
      if (task === undefined) {
        sendJson(res, 404, failure('task-not-found', '没有这个任务'))
        return
      }
      sendJson(res, 200, { ok: true, task })
      return
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const receipt = await deliver(await readJsonBody(req), new AbortController().signal)
      sendJson(res, 202, { ok: true, status: 'accepted', ...receipt })
      return
    }

    if (req.method === 'POST' && url.pathname === '/wait') {
      const body = await readJsonBody(req)
      const taskId = requireString(body.taskId, 'taskId')
      const task = tasks.get(taskId)
      if (task === undefined) throw httpError(404, 'task-not-found', '没有这个任务', { taskId })
      if (TERMINAL.has(task.status)) {
        sendJson(res, 200, { ok: true, timedOut: false, task })
        return
      }
      const timeoutMs = Number.isSafeInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_WAIT_MS
      const settled = await new Promise((resolve) => {
        const set = waiters.get(taskId) ?? new Set()
        set.add(resolve)
        waiters.set(taskId, set)
        const timer = setTimeout(() => {
          set.delete(resolve)
          if (set.size === 0) waiters.delete(taskId)
          resolve(undefined)
        }, timeoutMs)
        timer.unref?.()
      })
      const current = settled ?? tasks.get(taskId)
      // 超时不取消、不重发，只如实报告当前状态
      sendJson(res, 200, { ok: true, timedOut: settled === undefined, task: current })
      return
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await readJsonBody(req)
      const receipt = await deliver(body, new AbortController().signal)
      const task = tasks.get(receipt.taskId)
      const timeoutMs = Number.isSafeInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_WAIT_MS
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        if (TERMINAL.has(task.status)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (TERMINAL.has(task.status)) {
        sendJson(res, 200, {
          ok: true,
          status: 'completed',
          taskId: task.taskId,
          sessionId: task.sessionId,
          requestId: task.requestId,
          selection: task.selection,
          reason: task.result?.reason ?? 'idle',
          text: task.result?.text ?? '',
          attribution: task.attribution,
          delivery: task.delivery,
          truncated: task.result?.truncated === true,
        })
        return
      }

      const state = await safeState(task.sessionId)
      sendJson(res, 200, {
        ok: true,
        status: state?.running === true ? 'running' : 'unknown',
        taskId: task.taskId,
        sessionId: task.sessionId,
        requestId: task.requestId,
        selection: task.selection,
        reason: 'timeout',
        text: '',
        message: '消息已被接受且会话仍在运行；本次没有重发。请用 dsh_result / dsh_wait 按 taskId 取结果，不要再发一遍同样的任务。',
      })
      return
    }

    sendJson(res, 404, failure('not-found', `未知路由 ${req.method ?? '?'} ${url.pathname}`))
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'relay-error'
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, status, failure(code, message, error?.details))
      else res.end()
    })
  })
  server.on('error', (error) => {
    console.error(`[${NAME}] 监听 ${host}:${String(port)} 失败: ${error.message}`)
  })

  let timer
  ctx.effect(() => {
    let disposed = false
    // 先载入历史任务再监听：避免启动瞬间把已有任务误报成「不存在」
    const boot = async () => {
      await loadTasks()
      console.log(`[${NAME}] 已载入 ${String(tasks.size)} 个历史任务`)
      if (disposed) return
      server.listen(port, host, () => {
        console.log(`[${NAME}] 已就绪 http://${host}:${String(port)}  v${VERSION}`)
      })
      timer = setInterval(() => void tick(), tickMs)
      timer.unref?.()
    }
    void boot().catch((error) => {
      console.error(`[${NAME}] 启动失败: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      server.close()
    }
  })
}
