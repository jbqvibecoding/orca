import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { describeExhaustedSpawn, recordBudgetExhaustion } from './budget-exhaustion-event'
import type { OrchestrationEvent } from '../../../shared/orchestration-event'

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function exhaustedDb(): { db: OrchestrationDb; taskId: string; runId: string; budgetId: string } {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const first = db.createTask({ spec: 'first' })
  const budget = db.setBudget({ scope: 'run', runId: first.run_id, caps: { maxSpawns: 1 } })
  db.createDispatchContext(first.id, 'term_a', 'tab_a:11111111-1111-4111-8111-111111111111')
  const second = db.createTask({ spec: 'second' })
  return { db, taskId: second.id, runId: second.run_id, budgetId: budget.id }
}

describe('reading a refusal back off the error', () => {
  it('reports what was spent, not just that a limit was hit', () => {
    const { db, taskId, runId, budgetId } = exhaustedDb()
    let thrown: unknown
    try {
      db.createDispatchContext(taskId, 'term_b', 'tab_b:22222222-2222-4222-8222-222222222222')
    } catch (error) {
      thrown = error
    }

    const exhaustion = describeExhaustedSpawn(thrown, { db, taskId, runId })
    expect(exhaustion).toMatchObject({
      taskId,
      runId,
      budgetId,
      scope: 'run',
      dimension: 'spawns',
      observed: 1,
      cap: 1
    })
  })

  // A real dispatch bug reported as a budget stop would send someone to raise a
  // cap that was never the problem.
  it('returns null for any failure that is not a budget refusal', () => {
    const { db, taskId, runId } = exhaustedDb()
    expect(describeExhaustedSpawn(new Error('disk exploded'), { db, taskId, runId })).toBeNull()
    expect(
      describeExhaustedSpawn(new OrchestrationError('task_not_found', 'gone'), {
        db,
        taskId,
        runId
      })
    ).toBeNull()
  })

  // Between the refusal and this read an operator may have raised the cap.
  // Inventing numbers for an event would be worse than emitting none.
  it('returns null when the cap was raised before the reason could be read', () => {
    const { db, taskId, runId } = exhaustedDb()
    const error = new OrchestrationError('budget_exhausted', 'refused')
    db.setBudget({ scope: 'run', runId, caps: { maxSpawns: 99 } })
    expect(describeExhaustedSpawn(error, { db, taskId, runId })).toBeNull()
  })
})

describe('recording exhaustion on the event log', () => {
  it('writes one budget.exhausted event carrying the partial state', () => {
    const events: OrchestrationEvent[] = []
    recordBudgetExhaustion((event) => events.push(event), {
      runId: 'run_1',
      taskId: 'task_1',
      budgetId: 'bgt_1',
      scope: 'run',
      dimension: 'spawns',
      observed: 3,
      cap: 3,
      reason: 'Refused by the run budget: spawns used 3 of 3.'
    })

    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.kind).toBe('budget.exhausted')
    expect(event.attribution.budgetId).toBe('bgt_1')
    expect(event.payload).toMatchObject({ observed: 3, cap: 3, dimension: 'spawns' })
  })

  // Spawn counts are exact; tokens and spend are what the last usage scan saw.
  // A reader that could not tell them apart would treat a lagging number as the
  // moment's true spend.
  it('marks which dimensions are exact and which lag the usage scan', () => {
    const events: OrchestrationEvent[] = []
    const base = {
      runId: 'run_1',
      taskId: 'task_1',
      budgetId: 'bgt_1',
      scope: 'run' as const,
      observed: 1,
      cap: 1,
      reason: 'refused'
    }
    recordBudgetExhaustion((e) => events.push(e), { ...base, dimension: 'spawns' })
    recordBudgetExhaustion((e) => events.push(e), { ...base, dimension: 'tokens' })
    expect(events[0]!.payload.exact).toBe(true)
    expect(events[1]!.payload.exact).toBe(false)
  })

  it('keeps budget events separable from acceptance events on the same run', () => {
    const events: OrchestrationEvent[] = []
    recordBudgetExhaustion((event) => events.push(event), {
      runId: 'run_1',
      taskId: 'task_1',
      budgetId: 'bgt_1',
      scope: 'global',
      dimension: 'spend',
      observed: 10,
      cap: 5,
      reason: 'refused'
    })
    expect(events[0]!.causalityKey).toBe('budget:run_1')
  })
})
