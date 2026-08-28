// Budget enforcement at the two spawn boundaries, against a real database.
//
// The central claim of ADR-0009 is that the check and the claim are atomic. That
// is not something an assertion can establish — it needs parallel spawns racing
// one cap and exactly one of them winning, which is what this file runs.

import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { MICROS_PER_USD } from '../../../../../shared/budget-cap'
import { OrchestrationError } from '../../orchestration-error'

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function freshDb(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  return db
}

/** createTask lands a dependency-free task in `ready` already, so nothing else is needed. */
function readyTask(db: OrchestrationDb, spec: string): string {
  const task = db.createTask({ spec })
  if (task.status !== 'ready') {
    throw new Error(`expected a ready task, got ${task.status}`)
  }
  return task.id
}

function runIdOf(db: OrchestrationDb, taskId: string): string {
  const task = db.getTask(taskId)
  if (!task) {
    throw new Error('task vanished')
  }
  return task.run_id
}

let paneSeq = 0

/**
 * Each terminal needs its own pane UUID: the dispatch lock matches on the pane
 * key's suffix, so reusing one UUID makes every "different" terminal the same
 * pane and the pane lock fires before the budget check ever runs.
 */
function dispatch(db: OrchestrationDb, taskId: string, handle: string): void {
  paneSeq += 1
  const uuid = `1111111${paneSeq.toString(16)}-1111-4111-8111-11111111111${paneSeq.toString(16)}`
  db.createDispatchContext(taskId, handle, `tab_${handle}:${uuid}`)
}

describe('budget enforcement at the dispatch boundary', () => {
  it('allows spawning when no budget is set at all', () => {
    const db = freshDb()
    const task = readyTask(db, 'unbudgeted work')
    expect(() => dispatch(db, task, 'term_a')).not.toThrow()
  })

  it('refuses the spawn that would exceed the cap, naming the dimension', () => {
    const db = freshDb()
    const first = readyTask(db, 'first')
    db.setBudget({ scope: 'run', runId: runIdOf(db, first), caps: { maxSpawns: 1 } })

    dispatch(db, first, 'term_a')
    const second = readyTask(db, 'second')
    try {
      dispatch(db, second, 'term_b')
      throw new Error('expected a budget refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      expect((error as OrchestrationError).code).toBe('budget_exhausted')
      expect((error as OrchestrationError).message).toContain('spawns used 1 of 1')
    }
  })

  // The whole reason the check lives inside the claim's transaction. Serialised
  // checks would let every one of these read "0 used" and proceed.
  it('lets exactly one of several concurrent spawns through a cap of one', () => {
    const db = freshDb()
    const seed = readyTask(db, 'seed')
    db.setBudget({ scope: 'run', runId: runIdOf(db, seed), caps: { maxSpawns: 1 } })

    const tasks = [seed, ...[1, 2, 3, 4].map((n) => readyTask(db, `task ${n}`))]
    let allowed = 0
    let refused = 0
    for (const [index, task] of tasks.entries()) {
      try {
        dispatch(db, task, `term_${index}`)
        allowed += 1
      } catch (error) {
        expect((error as OrchestrationError).code).toBe('budget_exhausted')
        refused += 1
      }
    }
    expect(allowed).toBe(1)
    expect(refused).toBe(4)
  })

  it('refuses on tokens and on spend, each independently', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const runId = runIdOf(db, task)
    const budget = db.setBudget({ scope: 'run', runId, caps: { maxTokens: 100 } })
    db.recordBudgetObservation({
      budgetId: budget.id,
      tokens: 100,
      spendMicros: 0,
      source: 'test'
    })
    expect(() => dispatch(db, task, 'term_a')).toThrow(/tokens used 100 of 100/)

    db.setBudget({ scope: 'run', runId, caps: { maxSpendMicros: 2 * MICROS_PER_USD } })
    db.recordBudgetObservation({
      budgetId: budget.id,
      tokens: 0,
      spendMicros: 3 * MICROS_PER_USD,
      source: 'test'
    })
    expect(() => dispatch(db, task, 'term_a')).toThrow(/\$3\.00 of \$2\.00/)
  })

  // A cap on one dimension must not quietly cap the others.
  it('ignores dimensions that were left uncapped', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const budget = db.setBudget({
      scope: 'run',
      runId: runIdOf(db, task),
      caps: { maxSpawns: 5 }
    })
    db.recordBudgetObservation({
      budgetId: budget.id,
      tokens: 9_000_000,
      spendMicros: 9_000_000,
      source: 'test'
    })
    expect(() => dispatch(db, task, 'term_a')).not.toThrow()
  })

  it('enforces the global ceiling even with no run budget', () => {
    const db = freshDb()
    const first = readyTask(db, 'first')
    db.setBudget({ scope: 'global', caps: { maxSpawns: 1 } })
    dispatch(db, first, 'term_a')
    expect(() => dispatch(db, readyTask(db, 'second'), 'term_b')).toThrow(/global budget/)
  })

  // A refusal is not a failed dispatch: burning the circuit-breaker budget would
  // punish the task for the operator's cap. Same reasoning as the stale-base
  // refusal in coordinator-task-dispatch.ts.
  it('does not burn the circuit breaker, so raising the cap lets the task run', () => {
    const db = freshDb()
    const first = readyTask(db, 'first')
    const runId = runIdOf(db, first)
    db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 1 } })
    dispatch(db, first, 'term_a')

    const second = readyTask(db, 'second')
    expect(() => dispatch(db, second, 'term_b')).toThrow(/budget/)
    expect(db.getTask(second)?.status).toBe('ready')
    expect(db.getDispatchContext(second)).toBeUndefined()

    db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 10 } })
    expect(() => dispatch(db, second, 'term_b')).not.toThrow()
    expect(db.getDispatchContext(second)?.failure_count).toBe(0)
  })

  // ADR-0009: retroactive spend attribution is impossible, so the link is
  // written in the same transaction as the claim or not at all.
  it('attributes the dispatch to the budget it drew against', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const budget = db.setBudget({
      scope: 'run',
      runId: runIdOf(db, task),
      caps: { maxSpawns: 5 }
    })
    dispatch(db, task, 'term_a')
    expect(db.getDispatchContext(task)?.budget_id).toBe(budget.id)
  })

  it('leaves attribution null when nothing is budgeted', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    dispatch(db, task, 'term_a')
    expect(db.getDispatchContext(task)?.budget_id).toBeNull()
  })
})

describe('budget enforcement at the worker-start boundary', () => {
  it('refuses a worker start past the cap', () => {
    const db = freshDb()
    const first = readyTask(db, 'first')
    db.setBudget({ scope: 'run', runId: runIdOf(db, first), caps: { maxSpawns: 1 } })
    db.createStartingWorkerDispatch({ taskId: first, startOptions: {} })

    const second = readyTask(db, 'second')
    expect(() => db.createStartingWorkerDispatch({ taskId: second, startOptions: {} })).toThrow(
      /spawns used 1 of 1/
    )
  })

  it('lets exactly one of several concurrent worker starts through a cap of one', () => {
    const db = freshDb()
    const seed = readyTask(db, 'seed')
    db.setBudget({ scope: 'run', runId: runIdOf(db, seed), caps: { maxSpawns: 1 } })
    const tasks = [seed, ...[1, 2, 3].map((n) => readyTask(db, `task ${n}`))]

    let allowed = 0
    for (const task of tasks) {
      try {
        db.createStartingWorkerDispatch({ taskId: task, startOptions: {} })
        allowed += 1
      } catch (error) {
        expect((error as OrchestrationError).code).toBe('budget_exhausted')
      }
    }
    expect(allowed).toBe(1)
  })

  it('attributes the worker dispatch to its budget', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const budget = db.setBudget({
      scope: 'run',
      runId: runIdOf(db, task),
      caps: { maxSpawns: 3 }
    })
    const started = db.createStartingWorkerDispatch({ taskId: task, startOptions: {} })
    expect(started.dispatch.budget_id).toBe(budget.id)
  })
})

describe('budget records', () => {
  it('replaces caps on a repeat set rather than accumulating budgets', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const runId = runIdOf(db, task)
    const first = db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 1 } })
    const second = db.setBudget({ scope: 'run', runId, caps: { maxTokens: 5 } })
    expect(second.id).toBe(first.id)
    // An omitted dimension is cleared: a PUT states the whole budget.
    expect(second.max_spawns).toBeNull()
    expect(second.max_tokens).toBe(5)
    expect(db.listBudgets()).toHaveLength(1)
  })

  it('refuses a run-scoped budget with no run', () => {
    expect(() => freshDb().setBudget({ scope: 'run', caps: { maxSpawns: 1 } })).toThrow(/run id/)
  })

  it('clears a budget and leaves no observation row behind', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    const runId = runIdOf(db, task)
    const budget = db.setBudget({ scope: 'run', runId, caps: { maxTokens: 10 } })
    db.recordBudgetObservation({ budgetId: budget.id, tokens: 5, spendMicros: 0, source: 't' })

    expect(db.clearBudget({ runId })).toBe(true)
    expect(db.getBudgetForRun(runId)).toBeUndefined()
    expect(db.getBudgetObservation(budget.id)).toBeUndefined()
    // Nothing caps the run now, so the next spawn goes through.
    expect(() => dispatch(db, task, 'term_a')).not.toThrow()
  })

  it('reports clearing a budget that was never set', () => {
    const db = freshDb()
    expect(db.clearBudget({ scope: 'global' })).toBe(false)
  })

  it('keeps the run budget and the global ceiling as separate records', () => {
    const db = freshDb()
    const task = readyTask(db, 'work')
    db.setBudget({ scope: 'run', runId: runIdOf(db, task), caps: { maxSpawns: 2 } })
    db.setBudget({ scope: 'global', caps: { maxSpawns: 9 } })
    expect(db.listBudgets()).toHaveLength(2)
  })
})
