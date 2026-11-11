/**
 * 回归测试：工作区路由、任务持久化、结果归属、等待与通知恢复。
 *
 * events mock 按宿主真实语义实现：beforeSeq 是「向过去翻页的排他上界」，
 * end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let nextPort = 7801
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempDir = () => fs.mkdtemp(path.join(tmpdir(), 'relay-test-'))

/** 忠实模拟宿主 paginate：向过去翻页，maxMessages 按消息计数。 */
function paginateMock(state) {
  return async (request) => {
    // 把中继投递时用的 requestId 按顺序挂到 user/message 上，模拟宿主记录 rpcId
    let userIndex = 0
    const events = state.events.map((event) => {
      if (event.type !== 'user/message') return event
      const rpcId = state.requestIds[userIndex] ?? event.data?.source?.rpcId
      userIndex += 1
      return { ...event, data: { ...event.data, source: { ...(event.data?.source ?? {}), rpcId } } }
    })
    const through = request.throughSeq ?? events.length - 1
    const end = Math.min(through + 1, request.beforeSeq ?? through + 1)
    const max = request.maxMessages ?? 20
    let count = 0
    let cut = 0
    for (let index = end - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      count += 1
      cut = event.seq
      if (count >= max) break
    }
    return {
      cursor: through,
      hasMore: cut > 0,
      records: events.slice(cut, end).map((event) => ({ type: 'event', event })),
    }
  }
}

async function startRelay(options = {}) {
  const port = nextPort++
  const dataDir = options.dataDir ?? (await tempDir())
  const state = {
    rows: options.rows ?? [],
    archived: options.archived ?? [],
    titles: options.titles ?? {},
    running: options.running ?? false,
    cursor: options.cursor ?? 12,
    createdId: options.createdId ?? 'session-created',
    seq: options.seq ?? 5,
    events: options.events ?? [],
    stateImpl: options.stateImpl,
    promptImpl: options.promptImpl,
    notifyUrl: options.notifyUrl,
    promptCalls: [],
    requestIds: [],
    createCalls: [],
    dataDir,
  }

  const controller = {
    async list() {
      return { items: state.rows.map((row) => ({ ...row })) }
    },
    async prompt(request, signal) {
      state.promptCalls.push(request)
      state.requestIds.push(request.requestId)
      if (state.promptImpl) return state.promptImpl(request, signal)
      return { accepted: true }
    },
    async state() {
      if (state.stateImpl) return state.stateImpl()
      return { running: state.running, cursor: state.cursor }
    },
    events: paginateMock(state),
    async create(request) {
      state.createCalls.push(request)
      return { sessionId: state.createdId }
    },
  }

  const services = {
    sessionController: controller,
    sessions: { get: () => ({ seq: state.seq }) },
    agents: { list: () => [] },
    sessionPersistence: {
      async stat(id) {
        const title = state.titles[id]
        return title === undefined ? { header: {} } : { header: { title } }
      },
    },
    workspaceRegistry: {
      list: () => [],
      async resolveByPath() {
        return undefined
      },
      get archivedSessionIds() {
        return state.archived
      },
    },
  }

  const disposers = []
  const ctx = {
    get: (key) => services[key],
    effect: (fn) => {
      disposers.push(fn())
    },
  }

  const token = options.token === null ? undefined : (options.token ?? 'test-token')
  const relayConfig = { port, tickMs: options.tickMs ?? 15, dataDir }
  if (token !== undefined) relayConfig.token = token
  if (options.allowAnonymous === true) relayConfig.allowAnonymous = true
  if (state.notifyUrl !== undefined) relayConfig.notifyUrl = state.notifyUrl
  apply(ctx, relayConfig)

  // 等端口真正可服务，避免固定 sleep 造成的启动竞态
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // 还没起来
    }
    await delay(20)
  }
  if (!ready) throw new Error(`relay 未能在端口 ${port} 启动`)

  const base = `http://127.0.0.1:${port}`
  const call = async (method, urlPath, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = headers['content-type'] ?? 'application/json'
    const response = await fetch(base + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  /** 用 node:http 直接发请求，才能伪造 Host 头（fetch 不允许）。 */
  const rawCall = (opts = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'GET',
          path: opts.path ?? '/tasks',
          headers: opts.headers ?? {},
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve({ status: res.statusCode, body: data }))
        },
      )
      req.on('error', reject)
      req.end(opts.body)
    })

  return {
    state,
    call,
    rawCall,
    token,
    close() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 忽略关闭异常
        }
      }
    },
    cleanup: () => fs.rm(dataDir, { recursive: true, force: true }),
  }
}

const WS = '/tmp/ws-alpha'
const mainRow = (sessionId, cwd, extra = {}) => ({ sessionId, cwd, running: false, blank: false, updatedAt: 1000, ...extra })
const subagentRow = (sessionId, cwd, extra = {}) => ({ ...mainRow(sessionId, cwd, extra), origin: 'subagent', parentSessionId: 'session-parent' })

const turnEvents = (texts) => {
  const events = []
  let seq = 0
  for (const text of texts) {
    // 真实顺序：消息先进 inbox，turn 才开始，user/message 在 turn 内部落盘
    events.push({ type: 'agent/inbox/spliced', seq: seq, data: { target: 'next-turn' } })
    seq += 1
    events.push({ type: 'turn/start', seq: seq, data: {} })
    seq += 1
    events.push({ type: 'user/message', seq: seq, data: { source: { kind: 'user' } } })
    seq += 1
    if (text !== null) {
      events.push({ type: 'assistant/message', seq: seq, data: { message: { content: [{ type: 'text', text }] } } })
      seq += 1
    }
    events.push({ type: 'turn/end', seq: seq, data: { reason: { kind: 'completed' } } })
    seq += 1
  }
  return { events, lastSeq: seq - 1 }
}

// ---------- 路由 ----------

test('最新是子会话：跳过它，投给主会话', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS), subagentRow('session-child', WS, { updatedAt: 9999, running: true })] })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    assert.equal(response.status, 202)
    assert.equal(response.json.sessionId, 'session-main')
    assert.equal(response.json.selection.rule, 'recent-active')
    assert.ok(response.json.taskId.startsWith('task-'))
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('多个主会话：运行中优先，之后复用绑定', async () => {
  const relay = await startRelay({ rows: [mainRow('session-a', WS, { updatedAt: 2000 }), mainRow('session-b', WS, { updatedAt: 1000, running: true })] })
  try {
    const first = await relay.call('POST', '/send', { workspace: WS, text: '一' })
    assert.equal(first.json.sessionId, 'session-b')
    assert.equal(first.json.selection.rule, 'running')
    const second = await relay.call('POST', '/send', { workspace: WS, text: '二' })
    assert.equal(second.json.selection.rule, 'bound')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('绑定失效后重新解析', async () => {
  const relay = await startRelay({ rows: [mainRow('session-old', WS, { updatedAt: 3000 }), mainRow('session-new', WS, { updatedAt: 2000 })] })
  try {
    const first = await relay.call('POST', '/send', { workspace: WS, text: '一' })
    assert.equal(first.json.sessionId, 'session-old')
    relay.state.rows = [mainRow('session-new', WS, { updatedAt: 2000 })]
    const second = await relay.call('POST', '/send', { workspace: WS, text: '二' })
    assert.equal(second.json.sessionId, 'session-new')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('没有主会话时创建', async () => {
  const relay = await startRelay({ rows: [subagentRow('session-child', WS)], createdId: 'session-fresh' })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '开新活' })
    assert.equal(response.json.sessionId, 'session-fresh')
    assert.equal(response.json.selection.rule, 'created')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('显式 sessionId 指向子会话：409 且不投递', async () => {
  const relay = await startRelay({ rows: [subagentRow('session-child', WS)] })
  try {
    const response = await relay.call('POST', '/send', { sessionId: 'session-child', text: 'x' })
    assert.equal(response.status, 409)
    assert.equal(relay.state.promptCalls.length, 0)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

// ---------- 结果归属（真实分页语义） ----------

test('超时后完成：按 requestId 与 turn 段归属，正文正确', async () => {
  const { events } = turnEvents(['任务完成，测试通过。'])
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    running: true,
    seq: 0,
    cursor: events.length - 1,
    events,
  })
  try {
    const pending = await relay.call('POST', '/ask', { workspace: WS, text: '长任务', timeoutMs: 200 })
    assert.equal(pending.json.status, 'running')
    assert.equal(relay.state.promptCalls.length, 1)

    relay.state.running = false
    await delay(150)

    const result = await relay.call('GET', `/tasks/${pending.json.taskId}`)
    assert.equal(result.json.task.status, 'completed')
    assert.match(result.json.task.result.text, /任务完成/)
    assert.equal(result.json.task.attribution, 'rpc-turn-segment')
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('同会话连续任务：各自归属，不串内容', async () => {
  const { events, lastSeq } = turnEvents(['第一件完成', '第二件完成'])
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], seq: 0, cursor: lastSeq, events })
  try {
    const first = await relay.call('POST', '/send', { workspace: WS, text: '第一件事' })
    relay.state.seq = 5
    const second = await relay.call('POST', '/send', { workspace: WS, text: '第二件事' })
    relay.state.running = false
    await delay(150)

    const a = await relay.call('GET', `/tasks/${first.json.taskId}`)
    const b = await relay.call('GET', `/tasks/${second.json.taskId}`)
    assert.equal(a.json.task.result.text, '第一件完成')
    assert.equal(b.json.task.result.text, '第二件完成')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('空正文不假完成：turn 未结束就保持非终态，最终转待人工', async () => {
  const events = [
    { type: 'agent/inbox/spliced', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } },
    // 没有 assistant/message，也没有 turn/end
  ]
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], seq: 0, cursor: 2, events, tickMs: 10 })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    await delay(400)
    const task = await relay.call('GET', `/tasks/${sent.json.taskId}`)
    assert.notEqual(task.json.task.status, 'completed')
    assert.equal(task.json.task.status, 'awaiting-user')
    assert.equal(task.json.task.error.code, 'attribution-unavailable')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('宿主状态不可读：保持非终态，不假完成', async () => {
  const { events, lastSeq } = turnEvents(['完成'])
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    seq: 0,
    cursor: lastSeq,
    events,
    stateImpl: () => {
      throw new Error('host not ready')
    },
  })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    await delay(250)
    const task = await relay.call('GET', `/tasks/${sent.json.taskId}`)
    assert.equal(task.json.task.status, 'running')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('重复查询只读：不触发模型、不新增任务', async () => {
  const { events, lastSeq } = turnEvents(['好了'])
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], seq: 0, cursor: lastSeq, events })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    await delay(150)
    const first = await relay.call('GET', `/tasks/${sent.json.taskId}`)
    const second = await relay.call('GET', `/tasks/${sent.json.taskId}`)
    const list = await relay.call('GET', '/tasks')
    assert.equal(first.json.task.result.text, '好了')
    assert.deepEqual(second.json.task.result, first.json.task.result)
    assert.equal(list.json.total, 1)
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

// ---------- 重启恢复 ----------

test('重启恢复：新实例能查到旧任务', async () => {
  const dataDir = await tempDir()
  const rows = [mainRow('session-main', WS)]
  const first = await startRelay({ rows, dataDir })
  const sent = await first.call('POST', '/send', { workspace: WS, text: '干活' })
  first.close()
  await delay(60)

  const second = await startRelay({ rows, dataDir })
  try {
    let found
    for (let attempt = 0; attempt < 20; attempt += 1) {
      found = await second.call('GET', `/tasks/${sent.json.taskId}`)
      if (found.status === 200) break
      await delay(50)
    }
    assert.equal(found.status, 200)
    assert.equal(found.json.task.taskId, sent.json.taskId)
  } finally {
    second.close()
    await second.cleanup()
  }
})

test('投递意图已落盘但未见消息：重启后标记 unknown，绝不重发', async () => {
  const dataDir = await tempDir()
  const task = {
    taskId: 'task-queued-crash',
    requestId: 'rpc-never-arrived',
    sessionId: 'session-main',
    workspace: WS,
    selection: { rule: 'recent', workspace: WS },
    text: '干活',
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    afterSeq: 0,
    attributionAttempts: 0,
    notify: { state: 'pending', attempts: 0 },
    error: null,
  }
  await fs.writeFile(path.join(dataDir, `${task.taskId}.json`), JSON.stringify(task), 'utf8')

  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    dataDir,
    seq: 0,
    cursor: 3,
    events: [{ type: 'user/message', seq: 0, data: { source: { kind: 'user', rpcId: 'someone-else' } } }],
  })
  try {
    await delay(150)
    const found = await relay.call('GET', `/tasks/${task.taskId}`)
    assert.equal(found.json.task.status, 'unknown')
    assert.equal(found.json.task.error.code, 'unknown-delivery')
    // 关键：没有重新投递
    assert.equal(relay.state.promptCalls.length, 0)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('通知待办在重启后继续重试并成功', async () => {
  let hits = 0
  const endpoint = createServer((req, res) => {
    hits += 1
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const notifyPort = endpoint.address().port

  const dataDir = await tempDir()
  const task = {
    taskId: 'task-notify-pending',
    requestId: 'rpc-1',
    sessionId: 'session-main',
    workspace: WS,
    text: '干活',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    afterSeq: 0,
    attribution: 'rpc-turn-segment',
    result: { text: '完成', reason: 'idle', truncated: false },
    delivery: null,
    notify: { state: 'pending', attempts: 0 },
    error: null,
  }
  await fs.writeFile(path.join(dataDir, `${task.taskId}.json`), JSON.stringify(task), 'utf8')

  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    dataDir,
    notifyUrl: `http://127.0.0.1:${notifyPort}/hook`,
    events: [],
  })
  try {
    let found
    for (let attempt = 0; attempt < 40; attempt += 1) {
      found = await relay.call('GET', `/tasks/${task.taskId}`)
      if (found.json.task?.notify?.state === 'sent') break
      await delay(50)
    }
    assert.equal(found.json.task.notify.state, 'sent')
    assert.ok(hits >= 1)
  } finally {
    relay.close()
    await relay.cleanup()
    endpoint.close()
  }
})

test('通知失败：重试到上限后标记 failed', async () => {
  const endpoint = createServer((req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const notifyPort = endpoint.address().port

  const { events, lastSeq } = turnEvents(['完成'])
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    seq: 0,
    cursor: lastSeq,
    events,
    notifyUrl: `http://127.0.0.1:${notifyPort}/hook`,
  })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    let task
    for (let attempt = 0; attempt < 60; attempt += 1) {
      task = await relay.call('GET', `/tasks/${sent.json.taskId}`)
      if (task.json.task.notify.state === 'failed') break
      await delay(50)
    }
    assert.equal(task.json.task.status, 'completed')
    assert.equal(task.json.task.notify.state, 'failed')
    assert.equal(task.json.task.notify.attempts, 3)
  } finally {
    relay.close()
    await relay.cleanup()
    endpoint.close()
  }
})

test('没有通知渠道：标记 unsupported，不假装已通知', async () => {
  const { events, lastSeq } = turnEvents(['完成'])
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], seq: 0, cursor: lastSeq, events })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    await delay(150)
    const task = await relay.call('GET', `/tasks/${sent.json.taskId}`)
    assert.equal(task.json.task.notify.state, 'unsupported')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('dsh_wait 超时：不取消、不重发', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], running: true })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '长任务' })
    const waited = await relay.call('POST', '/wait', { taskId: sent.json.taskId, timeoutMs: 150 })
    assert.equal(waited.json.timedOut, true)
    assert.equal(waited.json.task.status, 'running')
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

// ---------- 安全：认证与请求校验 ----------

const authHeaders = (relay) => ({ authorization: `Bearer ${relay.token}` })

test('安全：不带令牌访问任务接口 → 401', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const res = await relay.rawCall({ path: '/tasks' })
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).error.code, 'unauthorized')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：错误令牌 → 401，正确令牌 → 200', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const bad = await relay.rawCall({ path: '/tasks', headers: { authorization: 'Bearer nope' } })
    assert.equal(bad.status, 401)
    const good = await relay.rawCall({ path: '/tasks', headers: authHeaders(relay) })
    assert.equal(good.status, 200)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：伪造 Origin → 403（挡恶意网页）', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const res = await relay.rawCall({
      path: '/tasks',
      headers: { ...authHeaders(relay), origin: 'https://evil.example' },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'origin-not-allowed')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：非回环 Host → 403（挡 DNS rebinding）', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const res = await relay.rawCall({
      path: '/tasks',
      headers: { ...authHeaders(relay), host: 'evil.example' },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'host-not-allowed')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：POST 非 JSON Content-Type → 415（挡简单表单 CSRF）', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const res = await relay.rawCall({
      method: 'POST',
      path: '/send',
      headers: { ...authHeaders(relay), 'content-type': 'text/plain' },
      body: JSON.stringify({ workspace: WS, text: 'x' }),
    })
    assert.equal(res.status, 415)
    assert.equal(JSON.parse(res.body).error.code, 'unsupported-media-type')
    assert.equal(relay.state.promptCalls.length, 0)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：未配置令牌时自动生成并落盘（600），重启复用同一令牌', async () => {
  const root = await tempDir()
  const dataDir = path.join(root, 'relay', 'tasks')
  const rows = [mainRow('session-main', WS)]

  const first = await startRelay({ rows, dataDir, token: null })
  const tokenPath = path.join(root, 'relay', 'token')
  const token1 = (await fs.readFile(tokenPath, 'utf8')).trim()
  const mode = (await fs.stat(tokenPath)).mode & 0o777
  first.close()
  assert.equal(token1.length, 64, '令牌长度应为 64 hex')
  assert.equal(mode, 0o600, '令牌文件权限应为 600')

  const second = await startRelay({ rows, dataDir, token: null })
  try {
    const token2 = (await fs.readFile(tokenPath, 'utf8')).trim()
    assert.equal(token2, token1, '重启后应复用同一令牌')
    const ok = await second.rawCall({ path: '/tasks', headers: { authorization: `Bearer ${token2}` } })
    assert.equal(ok.status, 200)
    const health = await second.call('GET', '/health')
    assert.equal(health.json.auth, 'token')
  } finally {
    second.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('安全：显式 allowAnonymous 才放行，并标记 auth=none', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], token: null, allowAnonymous: true })
  try {
    const res = await relay.rawCall({ path: '/tasks' })
    assert.equal(res.status, 200)
    const health = await relay.call('GET', '/health')
    assert.equal(health.json.auth, 'none')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：Content-Type 精确匹配，application/jsonp 不放行', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const res = await relay.rawCall({
      method: 'POST',
      path: '/send',
      headers: { ...authHeaders(relay), 'content-type': 'application/jsonp' },
      body: JSON.stringify({ workspace: WS, text: 'x' }),
    })
    assert.equal(res.status, 415)
    assert.equal(JSON.parse(res.body).error.code, 'unsupported-media-type')
    assert.equal(relay.state.promptCalls.length, 0)

    // 带 charset 参数仍应放行
    const ok = await relay.rawCall({
      method: 'POST',
      path: '/send',
      headers: { ...authHeaders(relay), 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ workspace: WS, text: 'x' }),
    })
    assert.equal(ok.status, 202)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('安全：已存在的宽权限令牌文件会被收紧到 600', async () => {
  const root = await tempDir()
  const relayDir = path.join(root, 'relay')
  const dataDir = path.join(relayDir, 'tasks')
  const tokenPath = path.join(relayDir, 'token')
  await fs.mkdir(relayDir, { recursive: true })
  await fs.writeFile(tokenPath, 'a'.repeat(64) + '\n', { mode: 0o644 })
  await fs.chmod(tokenPath, 0o644)
  assert.equal((await fs.stat(tokenPath)).mode & 0o777, 0o644)

  const relay = await startRelay({ rows: [mainRow('session-main', WS)], dataDir, token: null })
  try {
    assert.equal((await fs.stat(tokenPath)).mode & 0o777, 0o600, '启动后应收紧为 600')
    const ok = await relay.rawCall({ path: '/tasks', headers: { authorization: `Bearer ${'a'.repeat(64)}` } })
    assert.equal(ok.status, 200, '原令牌应继续可用')
  } finally {
    relay.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
