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
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const VERSION = '0.3.0'
const NAME = 'dsh-session-relay'
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_WAIT_MS = 120_000
const DEFAULT_MAX_MESSAGES = 20
const TERMINAL = new Set(['completed', 'failed'])
const NOTIFY_ATTEMPTS = 3

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

function assistantText(records) {
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

/** 从事件数组里再按 turn 边界收窄：从我们那条消息后第一个 turn/start，到下一个 turn/start。 */
function turnSegment(events, fromSeq) {
  const starts = events
    .filter((event) => event?.type === 'turn/start' && typeof event.seq === 'number')
    .map((event) => event.seq)
    .sort((a, b) => a - b)
  const first = starts.find((seq) => seq > fromSeq)
  if (first === undefined) return events.filter((event) => event.seq > fromSeq)
  const next = starts.find((seq) => seq > first)
  return events.filter((event) => event.seq >= first && (next === undefined || event.seq < next))
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 7391)
  const host = String(config.host ?? '127.0.0.1')
  const token =
    typeof config.token === 'string' && config.token.trim() !== '' ? config.token.trim() : undefined
  const tickMs = Number.isInteger(config.tickMs) && config.tickMs > 0 ? config.tickMs : 2000
  const notifyUrl =
    typeof config.notifyUrl === 'string' && config.notifyUrl.trim() !== '' ? config.notifyUrl.trim() : undefined
  const dataDir =
    typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
      ? config.dataDir.trim()
      : path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'relay', 'tasks')

  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`${NAME}: host 只能是回环地址，收到 "${host}"`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${NAME}: 端口非法`)

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
    const temp = `${file}.tmp`
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
          if (!TERMINAL.has(task.status)) markPending(task)
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
   * 读取 (fromSeq, toSeq] 之间、属于这次投递的助手输出。
   * 优先用宿主的按 seq 事件读取 + turn 边界；读不到就如实标记，不假装成功。
   */
  async function readSegment(sessionId, fromSeq, toSeq) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.events !== 'function') {
      return { text: '', attribution: 'unavailable', note: '宿主没有 events 接口' }
    }
    if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || toSeq <= fromSeq) {
      return { text: '', attribution: 'unavailable', note: '缺少可用的 seq 区间' }
    }
    try {
      const page = await controller.events(
        {
          address: { kind: 'session', sessionId },
          beforeSeq: fromSeq,
          throughSeq: toSeq,
          maxMessages: 200,
        },
        new AbortController().signal,
      )
      const events = (page?.records ?? []).map((record) => record?.event).filter(Boolean)
      const segment = turnSegment(events, fromSeq)
      const text = assistantText(segment.map((event) => ({ event })))
      return { text, attribution: 'seq-segment' }
    } catch (error) {
      return {
        text: '',
        attribution: 'unavailable',
        note: `读取会话事件失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async function finalizeSession(sessionId) {
    const ids = pending.get(sessionId)
    if (ids === undefined || ids.size === 0) return
    const state = await safeState(sessionId)
    // 只有会话空闲才收尾，避免把「仍在跑」误判成完成
    if (state?.running === true) return
    const cursor = typeof state?.cursor === 'number' ? state.cursor : undefined

    const ordered = [...ids]
      .map((id) => tasks.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.afterSeq ?? 0) - (b.afterSeq ?? 0))

    for (const task of ordered) {
      if (TERMINAL.has(task.status)) continue
      const endSeq = cursor ?? task.afterSeq
      const segment = await readSegment(task.sessionId, task.afterSeq, endSeq)
      const delivery = await gitInfo(task.workspace)
      await patchTask(task, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        endSeq,
        attribution: segment.attribution,
        ...(segment.note === undefined ? {} : { attributionNote: segment.note }),
        result: { text: segment.text, reason: 'idle', truncated: false },
        delivery: {
          ...(delivery ?? {}),
          tests: null,
          leftovers: null,
          note: '分支与提交为只读探测；测试结论与剩余问题需从任务正文读取',
        },
      })
      await notify(task)
    }
  }

  async function tick() {
    const sessionIds = [...pending.keys()]
    for (const sessionId of sessionIds) {
      try {
        await finalizeSession(sessionId)
      } catch (error) {
        console.error(`[${NAME}] 收尾 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ---------- 完成通知 ----------

  async function notify(task) {
    if (notifyUrl === undefined) {
      await patchTask(task, { notify: { state: 'unsupported', attempts: 0 } })
      return
    }
    let attempts = 0
    let lastError
    while (attempts < NOTIFY_ATTEMPTS) {
      attempts += 1
      try {
        const response = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskId: task.taskId,
            sessionId: task.sessionId,
            workspace: task.workspace,
            status: task.status,
            result: task.result,
            delivery: task.delivery,
          }),
        })
        if (!response.ok) throw new Error(`通知端点返回 ${String(response.status)}`)
        await patchTask(task, { notify: { state: 'sent', attempts, at: new Date().toISOString() } })
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await new Promise((resolve) => setTimeout(resolve, 50 * attempts))
      }
    }
    await patchTask(task, { notify: { state: 'failed', attempts, error: lastError } })
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
      afterSeq: -1,
      endSeq: null,
      attribution: null,
      result: null,
      delivery: null,
      notify: { state: 'pending', attempts: 0 },
      error: null,
    }

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
    task.afterSeq = typeof session?.seq === 'number' ? session.seq - 1 : -1
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    tasks.set(task.taskId, task)
    markPending(task)
    await persist(task)

    return { taskId: task.taskId, requestId, sessionId: target.sessionId, selection: target.selection, afterSeq: task.afterSeq }
  }

  // ---------- 路由 ----------

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: NAME, version: VERSION, tasks: tasks.size, notify: notifyUrl === undefined ? 'unsupported' : 'configured' })
      return
    }
    if (!authorized(req)) {
      sendJson(res, 401, failure('unauthorized', '缺少或错误的 Bearer token'))
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
    void loadTasks().then(() => {
      console.log(`[${NAME}] 已载入 ${String(tasks.size)} 个历史任务`)
    })
    server.listen(port, host, () => {
      console.log(`[${NAME}] 已就绪 http://${host}:${String(port)}  v${VERSION}`)
    })
    timer = setInterval(() => void tick(), tickMs)
    timer.unref?.()
    return () => {
      if (timer !== undefined) clearInterval(timer)
      server.close()
    }
  })
}
