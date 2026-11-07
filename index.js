/**
 * dsh-session-relay — 让本机上的外部程序按「工作空间」或 session id 给真实的 DSH 会话投递消息。
 *
 * 设计约束：零依赖。只使用 Node 内置模块和宿主正在运行的服务
 * （`ctx.sessionController` / `ctx.workspaceRegistry` / `ctx.sessionPersistence`），
 * 不声明任何 @deepseek-ai/* 依赖，因此不会与宿主版本产生“双份包”冲突。
 *
 * 会话归属判定只使用宿主声明的字段（origin / parentSessionId / archivedSessionIds），
 * 绝不根据 session id 的字面形态猜测。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const VERSION = '0.2.0'
const NAME = 'dsh-session-relay'
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_WAIT_MS = 120_000
const DEFAULT_MAX_MESSAGES = 20

/** @param {import('node:http').ServerResponse} res */
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

/** @param {import('node:http').IncomingMessage} req */
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

/**
 * 从 wait() 返回的 records 里抽出助手正文。
 * @param {unknown} records
 */
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

/**
 * @param {any} ctx Cordis 上下文
 * @param {{ port?: number, host?: string, token?: string }} config
 */
export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 7391)
  const host = String(config.host ?? '127.0.0.1')
  const token =
    typeof config.token === 'string' && config.token.trim() !== '' ? config.token.trim() : undefined

  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`${NAME}: host 只能是回环地址，收到 "${host}"`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${NAME}: 端口非法 "${String(config.port)}"`)
  }

  /** workspace 路径 → 最近一次成功投递的主会话（绑定）；失效即重新解析。 */
  const bindings = new Map()

  function requireSessionController() {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      throw httpError(503, 'controller-unavailable', `${NAME}: 宿主没有 sessionController 服务，无法投递消息`)
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

  /**
   * 只用宿主声明的字段判断会话类型与可投递性。
   * @param {any} row 宿主 list() 返回的行
   * @param {Set<string>} archived
   */
  function classify(row, archived) {
    const sessionId = row?.sessionId
    const reasons = []

    if (row?.origin === 'subagent' || row?.parentSessionId !== undefined) {
      reasons.push('子代理会话：由父会话拥有，不能直接接收外部消息')
    }
    if (archived.has(sessionId)) reasons.push('已归档会话')
    if (row?.formatStatus === 'migration-required') {
      reasons.push('会话格式待迁移：需要先在 GUI 里打开一次')
    }
    if (row?.cwd === undefined) reasons.push('会话缺少工作目录')

    return {
      kind: row?.origin === 'subagent' || row?.parentSessionId !== undefined ? 'subagent' : 'main',
      deliverable: reasons.length === 0,
      reason: reasons[0],
      reasons,
    }
  }

  /** 读宿主完整会话列表（含休眠），失败时退化为活跃会话。 */
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
    const rows = typeof agents?.list === 'function' ? agents.list() : []
    return rows
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

  /**
   * 列出会话，并附带类型、可投递性与不可投递原因。
   * @param {{ query?: string, cwd?: string }} filter
   */
  async function listSessions({ query, cwd } = {}) {
    const archived = archivedIds()
    const live = new Map()
    const agents = ctx.get('agents')
    for (const agent of typeof agents?.list === 'function' ? agents.list() : []) {
      if (typeof agent?.id === 'string') live.set(agent.id, agent?.status === 'running')
    }

    const needle = query === undefined ? undefined : query.toLowerCase()
    const rows = await rawRows()
    const out = []
    for (const row of rows) {
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
        ...(row?.blank === true ? { blank: true } : {}),
      })
    }
    return out
  }

  /**
   * 在同一工作空间里挑一个稳定的主会话。
   * 规则：绑定优先 → 运行中优先 → 最近活动的非空白会话 → 最近活动会话；
   * 同分时按 sessionId 字典序，保证结果稳定可复现。
   */
  function pickMain(candidates, workspacePath) {
    const sorted = [...candidates].sort((left, right) => {
      const byTime = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      if (byTime !== 0) return byTime
      return String(left.sessionId).localeCompare(String(right.sessionId))
    })

    const boundId = bindings.get(workspacePath)
    if (boundId !== undefined) {
      const bound = sorted.find((row) => row.sessionId === boundId)
      // 绑定仍然有效：该会话仍存在且仍可投递
      if (bound !== undefined) return { picked: bound, rule: 'bound' }
      // 绑定失效：清掉，走重新解析
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
      workspaceId === undefined
        ? await controller.create({ cwd: workspacePath })
        : await controller.create({ workspaceId })
    if (typeof created?.sessionId !== 'string') {
      throw httpError(502, 'create-failed', '新建会话失败：宿主未返回 sessionId')
    }
    return created.sessionId
  }

  /**
   * 决定这条消息投给谁。不猜 id，不盲目投递。
   * @returns {Promise<{ sessionId: string, selection: object }>}
   */
  async function resolveTarget(body) {
    // 1) 显式 sessionId：精确投递，但拒绝子会话与不可投递会话
    if (typeof body.sessionId === 'string' && body.sessionId.trim() !== '') {
      const sessionId = body.sessionId.trim()
      const archived = archivedIds()
      const row = (await rawRows()).find((candidate) => candidate?.sessionId === sessionId)
      if (row === undefined) {
        throw httpError(404, 'session-not-found', `会话不存在: ${sessionId}`, { sessionId })
      }
      const info = classify(row, archived)
      if (!info.deliverable) {
        throw httpError(409, 'session-not-deliverable', `会话 ${sessionId} 不可直接投递：${info.reason}`, {
          sessionId,
          kind: info.kind,
          reason: info.reason,
        })
      }
      return { sessionId, selection: { rule: 'explicit', candidateCount: 1 } }
    }

    // 2) workspace：在该目录下挑主会话，没有就新建
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

  /** 投递一条消息，返回目标会话、requestId、游标与选择依据。 */
  async function deliver(body, signal) {
    const text = requireString(body.text, 'text')
    const target = await resolveTarget(body)
    const requestId =
      typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : randomUUID()
    const request = {
      sessionId: target.sessionId,
      content: [{ type: 'text', text }],
      requestId,
      ...(body.mode === 'steer' ? { mode: 'steer' } : {}),
    }

    const controller = requireSessionController()
    try {
      await controller.prompt(request, signal)
    } catch (error) {
      // 投递被宿主拒绝：给出原因，并且不建立/不保留绑定
      if (target.selection?.workspace !== undefined) bindings.delete(target.selection.workspace)
      throw httpError(
        409,
        'delivery-rejected',
        `宿主拒绝了这次投递: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId: target.sessionId, code: error?.code },
      )
    }

    // 只有宿主确认接受后才建立绑定
    if (target.selection?.workspace !== undefined) {
      bindings.set(target.selection.workspace, target.sessionId)
    }

    const session = ctx.get('sessions')?.get?.(target.sessionId)
    const afterSeq = typeof session?.seq === 'number' ? session.seq - 1 : -1
    return { ...target, requestId, afterSeq }
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

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: NAME, version: VERSION })
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
        workspaces: rows.map((workspace) => ({
          workspaceId: workspace?.id,
          path: workspace?.path,
          ...(workspace?.title === undefined ? {} : { title: workspace.title }),
        })),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const query = url.searchParams.get('query') ?? undefined
      const cwd = url.searchParams.get('cwd') ?? undefined
      const sessions = await listSessions({ query, cwd })
      sendJson(res, 200, {
        ok: true,
        total: sessions.length,
        deliverable: sessions.filter((row) => row.deliverable === true).length,
        sessions,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await readJsonBody(req)
      const receipt = await deliver(body, new AbortController().signal)
      sendJson(res, 202, { ok: true, status: 'accepted', ...receipt })
      return
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await readJsonBody(req)
      const timeoutMs =
        Number.isSafeInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_WAIT_MS
      const maxMessages =
        Number.isSafeInteger(body.maxMessages) && body.maxMessages > 0
          ? body.maxMessages
          : DEFAULT_MAX_MESSAGES

      const abort = new AbortController()
      const guard = setTimeout(() => abort.abort(), timeoutMs + 15_000)
      try {
        const { sessionId, requestId, afterSeq, selection } = await deliver(body, abort.signal)

        let result
        try {
          result = await requireSessionController().wait(
            { sessionId, afterSeq, timeoutMs, maxMessages },
            abort.signal,
          )
        } catch (error) {
          const code = error?.code
          if (code === 'session/wait-timeout' || error?.name === 'AbortError' || code === 'ABORT_ERR') {
            // 关键：等待超时不重发。消息已经在跑，报告“仍在运行”并交还 id。
            const state = await safeState(sessionId)
            sendJson(res, 200, {
              ok: true,
              status: state?.running === true ? 'running' : 'unknown',
              sessionId,
              requestId,
              selection,
              reason: 'timeout',
              text: '',
              message:
                state?.running === true
                  ? '消息已被接受且会话仍在运行；本次没有重发，请稍后用同一 sessionId 查询结果'
                  : '等待超时，当前无法确认会话状态；本次没有重发，请稍后用同一 sessionId 查询',
            })
            return
          }
          throw error
        }

        const records = result?.output?.records
        sendJson(res, 200, {
          ok: true,
          status: 'completed',
          sessionId,
          requestId,
          selection,
          reason: result?.reason,
          text: assistantText(records),
          truncated: result?.output?.truncated === true,
        })
      } finally {
        clearTimeout(guard)
      }
      return
    }

    sendJson(res, 404, failure('not-found', `未知路由 ${req.method ?? '?'} ${url.pathname}`))
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'relay-error'
      const message = error instanceof Error ? error.message : String(error)
      const details = error?.details
      if (!res.headersSent) sendJson(res, status, failure(code, message, details))
      else res.end()
    })
  })

  server.on('error', (error) => {
    console.error(`[${NAME}] 监听 ${host}:${String(port)} 失败: ${error.message}`)
  })

  ctx.effect(() => {
    server.listen(port, host, () => {
      console.log(
        `[${NAME}] 已就绪 http://${host}:${String(port)}  (GET /health /workspaces /sessions, POST /send /ask)`,
      )
    })
    return () => {
      server.close()
    }
  })
}
