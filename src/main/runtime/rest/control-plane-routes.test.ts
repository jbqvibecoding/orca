// All six control-plane routes, over real HTTP against a real database.
//
// This is the roadmap's "consumed by something other than Orca's own UI": every
// call here goes out through node:http and comes back as JSON, exactly as an
// external control plane would drive it. What it does not prove is that
// paperclip specifically can drive it — nothing here is paperclip.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { MICROS_PER_USD } from '../../../shared/budget-cap'
import { createControlPlaneRouter, readBearerToken } from './control-plane-router'

import { createControlPlaneRoutes } from './control-plane-routes'

/** The routes return plain JSON; tests read it structurally rather than restating every shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON response is genuinely dynamic
type JsonBody = any

const TOKEN = 'device-token'

let db: OrchestrationDb
let server: Server
let origin: string

beforeEach(async () => {
  db = new OrchestrationDb(':memory:')
  const router = createControlPlaneRouter({
    routes: createControlPlaneRoutes(() => db),
    authenticate: (request) => readBearerToken(request) === TOKEN
  })
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
})

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: JsonBody }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

describe('GET /v1/tasks', () => {
  it('lists tasks with their approval state and goal ancestry', async () => {
    const parent = db.createTask({ spec: 'parent goal' })
    db.createTask({ spec: 'child work', parentId: parent.id })

    const { status, body } = await api('GET', '/v1/tasks')
    expect(status).toBe(200)
    expect(body.tasks).toHaveLength(2)
    const child = body.tasks.find(
      (candidate: { title: string | null; parentId: string | null }) =>
        candidate.title !== parent.task_title && candidate.parentId
    )
    expect(child.parentId).toBe(parent.id)
    expect(child.approval).toEqual({ state: 'not_required', by: null, at: null })
  })

  it('filters by run and 404s an unknown task', async () => {
    const task = db.createTask({ spec: 'work' })
    expect((await api('GET', `/v1/tasks?run=${task.run_id}`)).body.tasks).toHaveLength(1)
    expect((await api('GET', '/v1/tasks?run=run_nope')).body.tasks).toEqual([])
    expect((await api('GET', '/v1/tasks/task_nope')).status).toBe(404)
    expect((await api('GET', `/v1/tasks/${task.id}`)).body.task.id).toBe(task.id)
  })
})

describe('budget routes', () => {
  it('sets and reads back a run budget', async () => {
    const task = db.createTask({ spec: 'work' })
    const put = await api('PUT', '/v1/budgets/run', {
      runId: task.run_id,
      maxSpawns: 4,
      maxSpendMicros: 5 * MICROS_PER_USD
    })
    expect(put.status).toBe(200)
    expect(put.body.budget.caps).toEqual({
      maxSpawns: 4,
      maxTokens: null,
      maxSpendMicros: 5 * MICROS_PER_USD
    })

    const list = await api('GET', '/v1/budgets')
    expect(list.body.budgets).toHaveLength(1)
    expect(list.body.budgets[0].runId).toBe(task.run_id)
  })

  // The whole point of the phase, reached from outside: a cap set over REST
  // stops the next spawn.
  it('enforces a cap that was set over the wire', async () => {
    const first = db.createTask({ spec: 'first' })
    await api('PUT', '/v1/budgets/run', { runId: first.run_id, maxSpawns: 1 })

    db.createDispatchContext(first.id, 'term_a', 'tab_a:11111111-1111-4111-8111-111111111111')
    const second = db.createTask({ spec: 'second' })
    expect(() =>
      db.createDispatchContext(second.id, 'term_b', 'tab_b:22222222-2222-4222-8222-222222222222')
    ).toThrow(/spawns used 1 of 1/)
  })

  // Observed spend is what the last scan saw, so the response says when — three
  // numbers presented as equally current would be a lie about two of them.
  it('reports when the observed spend was measured', async () => {
    const task = db.createTask({ spec: 'work' })
    const put = await api('PUT', '/v1/budgets/run', { runId: task.run_id, maxTokens: 10 })
    expect(put.body.budget.observed.observedAt).toBeNull()

    db.recordBudgetObservation({
      budgetId: put.body.budget.id,
      tokens: 7,
      spendMicros: 0,
      source: 'claude-usage'
    })
    const after = await api('GET', '/v1/budgets')
    expect(after.body.budgets[0].observed).toMatchObject({ tokens: 7, source: 'claude-usage' })
    expect(after.body.budgets[0].observed.observedAt).not.toBeNull()
  })

  it('refuses a run budget with no run, and a bad cap value', async () => {
    expect((await api('PUT', '/v1/budgets/run', { maxSpawns: 1 })).status).toBe(400)
    const task = db.createTask({ spec: 'work' })
    for (const bad of [-1, 1.5, 'many']) {
      const result = await api('PUT', '/v1/budgets/run', { runId: task.run_id, maxSpawns: bad })
      expect(result.status, `maxSpawns=${bad}`).toBe(400)
    }
  })

  it('404s an unknown budget scope', async () => {
    expect((await api('PUT', '/v1/budgets/monthly', {})).status).toBe(404)
  })

  // A PUT states the whole budget: an omitted dimension is cleared. Otherwise
  // "no cap" and "unchanged" would be indistinguishable on the wire.
  it('clears an omitted dimension rather than keeping it', async () => {
    const task = db.createTask({ spec: 'work' })
    await api('PUT', '/v1/budgets/run', { runId: task.run_id, maxSpawns: 4, maxTokens: 100 })
    const second = await api('PUT', '/v1/budgets/run', { runId: task.run_id, maxTokens: 50 })
    expect(second.body.budget.caps).toEqual({
      maxSpawns: null,
      maxTokens: 50,
      maxSpendMicros: null
    })
  })
})

describe('approval routes', () => {
  it('records a decision and lists by state', async () => {
    const task = db.createTask({ spec: 'needs sign-off' })
    expect((await api('GET', '/v1/approvals')).body.approvals).toEqual([])

    const posted = await api('POST', `/v1/approvals/${task.id}`, {
      state: 'approved',
      by: 'alice'
    })
    expect(posted.status).toBe(200)
    expect(posted.body.task.approval).toMatchObject({ state: 'approved', by: 'alice' })

    const approved = await api('GET', '/v1/approvals?state=approved')
    expect(approved.body.approvals).toHaveLength(1)
  })

  // An approval with no approver is not a record of anything.
  it('requires an approver and a real decision', async () => {
    const task = db.createTask({ spec: 'work' })
    expect((await api('POST', `/v1/approvals/${task.id}`, { state: 'approved' })).status).toBe(400)
    expect(
      (await api('POST', `/v1/approvals/${task.id}`, { state: 'pending', by: 'alice' })).status
    ).toBe(400)
  })

  // A task that does not exist is the caller's mistake, not a server fault.
  it('404s an approval for a task that does not exist', async () => {
    expect(
      (await api('POST', '/v1/approvals/task_nope', { state: 'approved', by: 'a' })).status
    ).toBe(404)
  })

  it('refuses an unknown state filter instead of returning everything', async () => {
    expect((await api('GET', '/v1/approvals?state=maybe')).status).toBe(400)
  })
})
