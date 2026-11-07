/**
 * 回归测试：工作区路由、任务持久化、结果归属、等待与通知。
 * 用假 ctx 驱动插件 HTTP 接口，不依赖真实宿主。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let nextPort = 7701
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function tempDir() {
  return fs.mkdtemp(path.join(tmpdir(), 'relay-test-'))
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
    promptImpl: options.promptImpl,
    eventsImpl: options.eventsImpl,
    notifyUrl: options.notifyUrl,
    promptCalls: [],
    createCalls: [],
    dataDir,
  }

  const controller = {
    async list() {
      return { items: state.rows.map((row) => ({ ...row })) }
    },
    async prompt(request, signal) {
      state.promptCalls.push(request)
      if (state.promptImpl) return state.promptImpl(request, signal)
      return { accepted: true }
    },
    async state() {
      return { running: state.running, cursor: state.cursor }
    },
    async events(request) {
      if (state.eventsImpl) return state.eventsImpl(request)
      const events = state.events.filter(
        (event) => event.seq > request.beforeSeq && event.seq <= request.throughSeq,
      )
      return { cursor: request.throughSeq, hasMore: false, records: events.map((event) => ({ type: 'event', event })) }
    },
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

  apply(ctx, {
    port,
    tickMs: options.tickMs ?? 20,
    ...(state.notifyUrl === undefined ? {} : { notifyUrl: state.notifyUrl }),
    dataDir,
  })
  await delay(150)

  const base = `http://127.0.0.1:${port}`
  const call = async (method, urlPath, body) => {
    const response = await fetch(base + urlPath, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  return {
    state,
    call,
    base,
    close() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 忽略关闭异常
        }
      }
    },
    async cleanup() {
      await fs.rm(dataDir, { recursive: true, force: true })
    },
  }
}

const WS = '/tmp/ws-alpha'
const mainRow = (sessionId, cwd, extra = {}) => ({ sessionId, cwd, running: false, blank: false, updatedAt: 1000, ...extra })
const subagentRow = (sessionId, cwd, extra = {}) => ({ ...mainRow(sessionId, cwd, extra), origin: 'subagent', parentSessionId: 'session-parent' })

// ---------- 路由（沿用上一轮） ----------

test('最新是子会话：跳过它，投给主会话', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS), subagentRow('session-child', WS, { updatedAt: 9999, running: true })] })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    assert.equal(response.status, 202)
    assert.equal(response.json.sessionId, 'session-main')
    assert.equal(response.json.selection.rule, 'recent-active')
    assert.ok(response.json.taskId.startsWith('task-'))
    assert.ok(response.json.requestId)
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
    assert.equal(second.json.sessionId, 'session-b')
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
    assert.notEqual(second.json.selection.rule, 'bound')
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
    assert.deepEqual(relay.state.createCalls, [{ cwd: WS }])
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
    assert.equal(response.json.error.details.kind, 'subagent')
    assert.equal(relay.state.promptCalls.length, 0)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

// ---------- 任务持久化与结果归属 ----------

test('派工回执含 taskId / requestId / 会话 / 工作区', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    const { taskId, requestId, sessionId, selection } = response.json
    assert.ok(taskId.startsWith('task-'))
    assert.ok(requestId)
    assert.equal(sessionId, 'session-main')
    assert.equal(selection.workspace, WS)

    const task = await relay.call('GET', `/tasks/${taskId}`)
    assert.equal(task.status, 200)
    assert.equal(task.json.task.workspace, WS)
    assert.equal(task.json.task.status, 'running')
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('超时后完成：ask 先返回 running，随后按 taskId 查到 completed 与正文', async () => {
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    running: true,
    cursor: 8,
    seq: 5,
    events: [
      { type: 'user/message', seq: 5, data: { source: { kind: 'user' } } },
      { type: 'turn/start', seq: 6, data: {} },
      { type: 'assistant/message', seq: 7, data: { message: { role: 'assistant', content: [{ type: 'text', text: '任务完成，测试通过。' }] } } },
    ],
  })
  try {
    const pending = await relay.call('POST', '/ask', { workspace: WS, text: '长任务', timeoutMs: 200 })
    assert.equal(pending.json.status, 'running')
    assert.equal(pending.json.reason, 'timeout')
    assert.ok(pending.json.taskId)
    assert.equal(pending.json.text, '')
    // 关键：没有重发
    assert.equal(relay.state.promptCalls.length, 1)

    // 任务继续跑，随后空闲
    relay.state.running = false
    relay.state.cursor = 8
    await delay(120)

    const result = await relay.call('GET', `/tasks/${pending.json.taskId}`)
    assert.equal(result.json.task.status, 'completed')
    assert.match(result.json.task.result.text, /任务完成/)
    assert.equal(result.json.task.attribution, 'seq-segment')
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('同会话连续任务：结果按 turn 段各自归属', async () => {
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    cursor: 12,
    seq: 5,
    events: [
      { type: 'user/message', seq: 5, data: {} },
      { type: 'turn/start', seq: 6, data: {} },
      { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '第一件完成' }] } } },
      { type: 'user/message', seq: 8, data: {} },
      { type: 'turn/start', seq: 9, data: {} },
      { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '第二件完成' }] } } },
    ],
  })
  try {
    const first = await relay.call('POST', '/send', { workspace: WS, text: '第一件事' })
    relay.state.seq = 9
    const second = await relay.call('POST', '/send', { workspace: WS, text: '第二件事' })
    assert.notEqual(first.json.taskId, second.json.taskId)

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

test('重复查询只读：不触发模型、不新增任务', async () => {
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    events: [
      { type: 'turn/start', seq: 6, data: {} },
      { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '好了' }] } } },
    ],
  })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    await delay(120)
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

test('重启恢复：新实例能查到旧任务', async () => {
  const dataDir = await tempDir()
  const rows = [mainRow('session-main', WS)]
  const first = await startRelay({ rows, dataDir })
  const sent = await first.call('POST', '/send', { workspace: WS, text: '干活' })
  first.close()
  await delay(60)

  const second = await startRelay({ rows, dataDir })
  try {
    const found = await second.call('GET', `/tasks/${sent.json.taskId}`)
    assert.equal(found.status, 200)
    assert.equal(found.json.task.taskId, sent.json.taskId)
    assert.equal(found.json.task.sessionId, 'session-main')
  } finally {
    second.close()
    await second.cleanup()
  }
})

test('dsh_wait 超时：返回当前状态，不取消、不重发', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)], running: true })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '长任务' })
    const waited = await relay.call('POST', '/wait', { taskId: sent.json.taskId, timeoutMs: 150 })
    assert.equal(waited.status, 200)
    assert.equal(waited.json.timedOut, true)
    assert.equal(waited.json.task.status, 'running')
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
    await relay.cleanup()
  }
})

test('完成通知失败：记录待办并重试，最终标记 failed', async () => {
  const endpoint = createServer((req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const notifyPort = endpoint.address().port

  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    notifyUrl: `http://127.0.0.1:${notifyPort}/hook`,
    events: [
      { type: 'turn/start', seq: 6, data: {} },
      { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '完成' }] } } },
    ],
  })
  try {
    const sent = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    relay.state.running = false
    // 通知带重试退避，轮询等它落定
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

test('没有通知渠道时：明确标记 unsupported，不假装已通知', async () => {
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    events: [
      { type: 'turn/start', seq: 6, data: {} },
      { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '完成' }] } } },
    ],
  })
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
