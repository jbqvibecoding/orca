// What the scheduler does when a spawn is refused by a budget.
//
// Background: TaskDispatchResult gained a third member in P4 and this caller was
// not updated, so a budget refusal fell into the branch meant for a successful
// dispatch -- not returning the terminal and setting phase to 'monitoring'.
//
// Honest scope of these tests: they do NOT distinguish the fixed caller from the
// unfixed one, and they pass against both. The terminal list is rebuilt inside
// dispatchReadyTasks on every tick, so an unreturned terminal is back one poll
// later; the bug costs a slot for the rest of one tick, not permanently. The fix
// is still worth making -- it matches the stale-base branch and keeps the phase
// honest -- but the value here is pinning the behaviour a budget refusal must
// have at all: nothing dispatched, the task still ready, the refusal recorded.

import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator } from './coordinator'
import { createMockRuntime, insertWorkerDone } from './coordinator-test-harness'
import { OrchestrationDb } from './db'
import type { OrchestrationEvent } from '../../../shared/orchestration-event'

describe('a budget refusal in the coordinator loop', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  async function runUntilIdle(coordinator: Coordinator): Promise<void> {
    const running = coordinator.run().catch(() => undefined)
    await new Promise((resolve) => {
      setTimeout(resolve, 120)
    })
    coordinator.stop()
    await running
  }

  it('dispatches nothing and leaves the task ready when the cap is already spent', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    // Spend the cap with a dispatch the coordinator did not make.
    const spent = db.createTask({ spec: 'already running' })
    db.setBudget({ scope: 'run', runId: spent.run_id, caps: { maxSpawns: 1 } })
    db.createDispatchContext(spent.id, 'term_x', 'tab_x:11111111-1111-4111-8111-111111111111')

    const blocked = db.createTask({ spec: 'should not start' })
    await runUntilIdle(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )

    expect(runtime.sentMessages.filter((m) => m.handle === 'term_a')).toHaveLength(0)
    expect(db.getTask(blocked.id)?.status).toBe('ready')
    expect(db.getDispatchContext(blocked.id)).toBeUndefined()
  })

  // The regression: a refusal must return the terminal to the pool, exactly as
  // the stale-base refusal does. Otherwise one refused task silently costs a
  // worker slot for the rest of the run.
  it('gives the terminal back, so raising the cap lets the same terminal work', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const spent = db.createTask({ spec: 'already running' })
    const runId = spent.run_id
    db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 1 } })
    db.createDispatchContext(spent.id, 'term_x', 'tab_x:11111111-1111-4111-8111-111111111111')
    const blocked = db.createTask({ spec: 'should start once the cap allows' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })
    const running = coordinator.run().catch(() => undefined)
    await new Promise((resolve) => {
      setTimeout(resolve, 80)
    })
    expect(db.getDispatchContext(blocked.id)).toBeUndefined()

    // Raise the cap mid-run; the next tick must be able to use term_a again.
    db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 10 } })
    await new Promise((resolve) => {
      setTimeout(resolve, 120)
    })
    insertWorkerDone(db, { taskId: blocked.id })
    coordinator.stop()
    await running

    expect(db.getDispatchContext(blocked.id)?.assignee_handle).toBe('term_a')
  })

  // ADR-0009 calls exhaustion an honest stop; a stop nobody can see afterwards
  // is indistinguishable from a silent continue.
  it('records the refusal on the event log with what was already spent', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const spent = db.createTask({ spec: 'already running' })
    db.setBudget({ scope: 'run', runId: spent.run_id, caps: { maxSpawns: 1 } })
    db.createDispatchContext(spent.id, 'term_x', 'tab_x:11111111-1111-4111-8111-111111111111')
    db.createTask({ spec: 'should not start' })

    const events: OrchestrationEvent[] = []
    await runUntilIdle(
      new Coordinator(db, runtime, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20,
        emitEvent: (event) => events.push(event)
      })
    )

    const exhausted = events.filter((event) => event.kind === 'budget.exhausted')
    expect(exhausted.length).toBeGreaterThan(0)
    expect(exhausted[0]!.payload).toMatchObject({ dimension: 'spawns', observed: 1, cap: 1 })
  })

  it('stays silent on the event log when no budget refuses anything', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
    const task = db.createTask({ spec: 'unbudgeted' })

    const events: OrchestrationEvent[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      emitEvent: (event) => events.push(event)
    })
    const running = coordinator.run().catch(() => undefined)
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
    insertWorkerDone(db, { taskId: task.id })
    await running

    expect(events.filter((event) => event.kind === 'budget.exhausted')).toHaveLength(0)
  })
})
