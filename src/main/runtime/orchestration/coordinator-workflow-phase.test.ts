import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator } from './coordinator'
import { createMockRuntime, insertWorkerDone } from './coordinator-test-harness'
import { OrchestrationDb } from './db'

describe('workflow phase in the dispatch preamble', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('sends the phase a task is on, with its completion artifact', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'do the work' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning',
      instruction: 'You are in the PLANNING phase.',
      artifact: '.orca/plan.md'
    })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 100)
    })
    insertWorkerDone(db, { taskId: task.id })
    await runPromise

    const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
    expect(sent!.text).toContain('=== PHASE: planning ===')
    expect(sent!.text).toContain('You are in the PLANNING phase.')
    expect(sent!.text).toContain('finished when .orca/plan.md exists')
  })

  // Adopting phases must not change what a task without one is told.
  it('sends no phase section for a task that is not on a workflow', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
    const task = db.createTask({ spec: 'do the work' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 100)
    })
    insertWorkerDone(db, { taskId: task.id })
    await runPromise

    const sent = runtime.sentMessages.find((m) => m.handle === 'term_a')
    expect(sent!.text).not.toContain('=== PHASE')
  })
})
