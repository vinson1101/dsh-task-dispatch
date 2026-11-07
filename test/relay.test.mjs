/**
 * 回归测试：工作区路由、子会话隔离、绑定失效、投递拒绝、等待超时。
 *
 * 用假 ctx 直接驱动插件的 HTTP 接口，不依赖真实宿主。
 * 运行：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

let nextPort = 7601

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 建一个假宿主 + 起一个中继实例。 */
async function startRelay(options = {}) {
  const port = nextPort++
  const state = {
    rows: options.rows ?? [],
    archived: options.archived ?? [],
    titles: options.titles ?? {},
    running: options.running ?? false,
    createdId: options.createdId ?? 'session-created',
    promptImpl: options.promptImpl,
    waitImpl: options.waitImpl,
    promptCalls: [],
    waitCalls: [],
    createCalls: [],
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
    async wait(request, signal) {
      state.waitCalls.push(request)
      if (state.waitImpl) return state.waitImpl(request, signal)
      return {
        reason: 'idle',
        state: { cursor: 10, running: false },
        output: {
          truncated: false,
          records: [
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 10,
                data: { message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } },
              },
            },
          ],
        },
      }
    },
    async state() {
      return { running: state.running, cursor: 10 }
    },
    async create(request) {
      state.createCalls.push(request)
      return { sessionId: state.createdId }
    },
  }

  const services = {
    sessionController: controller,
    sessions: { get: () => ({ seq: 10 }) },
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

  apply(ctx, { port })
  await delay(120)

  const base = `http://127.0.0.1:${port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  return {
    state,
    call,
    close() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 忽略关闭阶段的异常
        }
      }
    },
  }
}

function mainRow(sessionId, cwd, extra = {}) {
  return { sessionId, cwd, running: false, blank: false, updatedAt: 1000, ...extra }
}

function subagentRow(sessionId, cwd, extra = {}) {
  return { ...mainRow(sessionId, cwd, extra), origin: 'subagent', parentSessionId: 'session-parent' }
}

const WS = '/tmp/ws-alpha'

test('最新记录是子会话：自动选择跳过它，投给主会话', async () => {
  const relay = await startRelay({
    rows: [
      mainRow('session-main', WS, { updatedAt: 1000 }),
      subagentRow('session-child-newest', WS, { updatedAt: 9999, running: true }),
    ],
  })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    assert.equal(response.status, 202)
    assert.equal(response.json.sessionId, 'session-main')
    assert.equal(response.json.selection.rule, 'recent-active')
    assert.equal(response.json.selection.excludedCount, 1)
    assert.equal(relay.state.promptCalls.length, 1)
  } finally {
    relay.close()
  }
})

test('运行中的子会话：仍然排除，不接管', async () => {
  const relay = await startRelay({
    rows: [
      subagentRow('session-child-running', WS, { updatedAt: 9999, running: true }),
      mainRow('session-main-idle', WS, { updatedAt: 500 }),
    ],
  })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    assert.equal(response.json.sessionId, 'session-main-idle')
    assert.notEqual(response.json.sessionId, 'session-child-running')
  } finally {
    relay.close()
  }
})

test('多个主会话：运行中优先，其次最近活动，回执说明选择依据', async () => {
  const relay = await startRelay({
    rows: [
      mainRow('session-a', WS, { updatedAt: 2000, running: false }),
      mainRow('session-b', WS, { updatedAt: 1000, running: true }),
    ],
  })
  try {
    const runningPick = await relay.call('POST', '/send', { workspace: WS, text: '一' })
    assert.equal(runningPick.json.sessionId, 'session-b')
    assert.equal(runningPick.json.selection.rule, 'running')
    assert.equal(runningPick.json.selection.candidateCount, 2)

    // 第二次仍应复用绑定，规则变为 bound（稳定，不来回跳）
    const second = await relay.call('POST', '/send', { workspace: WS, text: '二' })
    assert.equal(second.json.sessionId, 'session-b')
    assert.equal(second.json.selection.rule, 'bound')
  } finally {
    relay.close()
  }
})

test('绑定失效：会话消失后重新解析到另一个主会话', async () => {
  const relay = await startRelay({
    rows: [
      mainRow('session-old', WS, { updatedAt: 3000 }),
      mainRow('session-new', WS, { updatedAt: 2000 }),
    ],
  })
  try {
    const first = await relay.call('POST', '/send', { workspace: WS, text: '一' })
    assert.equal(first.json.sessionId, 'session-old')
    assert.equal(first.json.selection.rule, 'recent-active')

    // 绑定的会话从宿主列表消失
    relay.state.rows = [mainRow('session-new', WS, { updatedAt: 2000 })]
    const second = await relay.call('POST', '/send', { workspace: WS, text: '二' })
    assert.equal(second.json.sessionId, 'session-new')
    assert.notEqual(second.json.selection.rule, 'bound')
  } finally {
    relay.close()
  }
})

test('没有可用主会话：沿用创建流程', async () => {
  const relay = await startRelay({
    rows: [subagentRow('session-only-child', WS)],
    createdId: 'session-fresh',
  })
  try {
    const response = await relay.call('POST', '/send', { workspace: WS, text: '开个新活' })
    assert.equal(response.status, 202)
    assert.equal(response.json.sessionId, 'session-fresh')
    assert.equal(response.json.selection.rule, 'created')
    assert.deepEqual(relay.state.createCalls, [{ cwd: WS }])
  } finally {
    relay.close()
  }
})

test('投递被宿主拒绝：返回明确错误，且不保留绑定', async () => {
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    promptImpl: async () => {
      const error = new Error('session is owned by a running subagent')
      error.code = 'session/agent-busy'
      throw error
    },
  })
  try {
    const rejected = await relay.call('POST', '/send', { workspace: WS, text: '干活' })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.json.ok, false)
    assert.equal(rejected.json.error.code, 'delivery-rejected')
    assert.equal(rejected.json.error.details.sessionId, 'session-main')

    // 第二次仍走重新解析（rule 不是 bound）
    const second = await relay.call('POST', '/send', { workspace: WS, text: '再试' })
    assert.equal(second.status, 409)
    assert.equal(relay.state.promptCalls.length, 2)
  } finally {
    relay.close()
  }
})

test('等待超时：报告仍在运行，不重发', async () => {
  let waitCalls = 0
  const relay = await startRelay({
    rows: [mainRow('session-main', WS)],
    running: true,
    waitImpl: async () => {
      waitCalls += 1
      const error = new Error('No Session state arrived before the wait deadline')
      error.code = 'session/wait-timeout'
      throw error
    },
  })
  try {
    const response = await relay.call('POST', '/ask', {
      workspace: WS,
      text: '长任务',
      timeoutMs: 1000,
    })
    assert.equal(response.status, 200)
    assert.equal(response.json.status, 'running')
    assert.equal(response.json.reason, 'timeout')
    assert.equal(response.json.sessionId, 'session-main')
    assert.ok(response.json.requestId)
    assert.equal(response.json.text, '')
    // 关键：只投递一次，等待也只发起一次
    assert.equal(relay.state.promptCalls.length, 1)
    assert.equal(waitCalls, 1)
  } finally {
    relay.close()
  }
})

test('显式 sessionId 指向子会话：返回清晰错误', async () => {
  const relay = await startRelay({
    rows: [subagentRow('session-child', WS)],
  })
  try {
    const response = await relay.call('POST', '/send', {
      sessionId: 'session-child',
      text: '越过父会话直接投递',
    })
    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'session-not-deliverable')
    assert.equal(response.json.error.details.kind, 'subagent')
    assert.match(response.json.error.details.reason, /子代理会话/)
    assert.equal(relay.state.promptCalls.length, 0)
  } finally {
    relay.close()
  }
})

test('显式 sessionId 不存在：404', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const response = await relay.call('POST', '/send', { sessionId: 'session-nope', text: 'x' })
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'session-not-found')
  } finally {
    relay.close()
  }
})

test('/sessions 暴露类型、可投递性与不可投递原因', async () => {
  const relay = await startRelay({
    rows: [
      mainRow('session-main', WS, { updatedAt: 2000 }),
      subagentRow('session-child', WS, { updatedAt: 3000 }),
    ],
    archived: ['session-main'],
    titles: { 'session-main': '主会话', 'session-child': '子会话' },
  })
  try {
    const response = await relay.call('GET', '/sessions')
    assert.equal(response.status, 200)
    assert.equal(response.json.total, 2)
    assert.equal(response.json.deliverable, 0)

    const main = response.json.sessions.find((row) => row.sessionId === 'session-main')
    const child = response.json.sessions.find((row) => row.sessionId === 'session-child')
    assert.equal(main.kind, 'main')
    assert.equal(main.deliverable, false)
    assert.equal(main.archived, true)
    assert.match(main.reason, /已归档/)
    assert.equal(child.kind, 'subagent')
    assert.equal(child.deliverable, false)
    assert.match(child.reason, /子代理会话/)
  } finally {
    relay.close()
  }
})

test('/ask 正常完成：返回 completed 与正文', async () => {
  const relay = await startRelay({ rows: [mainRow('session-main', WS)] })
  try {
    const response = await relay.call('POST', '/ask', { workspace: WS, text: '报告' })
    assert.equal(response.status, 200)
    assert.equal(response.json.status, 'completed')
    assert.equal(response.json.text, '完成')
    assert.equal(response.json.sessionId, 'session-main')
  } finally {
    relay.close()
  }
})
