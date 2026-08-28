import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { MICROS_PER_USD } from '../../../shared/budget-cap'
import type { AutomationRunUsage } from '../../../shared/automations-types'
import { addSamples, recordRunUsageAgainstBudget, sampleFromUsage } from './budget-usage-feed'

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function usage(overrides: Partial<AutomationRunUsage>): AutomationRunUsage {
  return {
    status: 'known',
    provider: 'claude',
    model: 'claude-opus-4-1',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningOutputTokens: null,
    totalTokens: 100,
    estimatedCostUsd: 1.5,
    estimatedCostSource: 'api_equivalent',
    providerSessionId: null,
    attribution: null,
    collectedAt: Date.now(),
    unavailableReason: null,
    unavailableMessage: null,
    ...overrides
  } as AutomationRunUsage
}

describe('reading usage into a budget sample', () => {
  it('converts dollars to micros without a float reaching the store', () => {
    expect(sampleFromUsage(usage({ estimatedCostUsd: 1.5, totalTokens: 100 }))).toEqual({
      tokens: 100,
      spendMicros: 1.5 * MICROS_PER_USD
    })
    expect(
      Number.isInteger(sampleFromUsage(usage({ estimatedCostUsd: 0.0000004 }))!.spendMicros)
    ).toBe(true)
  })

  // Recording an unmeasurable run as zero would let the budget drift further
  // from reality on every failed measurement, and do it silently.
  it('yields nothing for usage that could not be measured', () => {
    expect(sampleFromUsage(usage({ status: 'unavailable' }))).toBeNull()
    expect(sampleFromUsage(usage({ totalTokens: null, estimatedCostUsd: null }))).toBeNull()
  })

  it('keeps a dimension the provider did report when the other is missing', () => {
    expect(sampleFromUsage(usage({ totalTokens: 42, estimatedCostUsd: null }))).toEqual({
      tokens: 42,
      spendMicros: 0
    })
  })

  it('adds samples across providers', () => {
    expect(
      addSamples([
        { tokens: 10, spendMicros: 100 },
        { tokens: 5, spendMicros: 50 }
      ])
    ).toEqual({ tokens: 15, spendMicros: 150 })
    expect(addSamples([])).toEqual({ tokens: 0, spendMicros: 0 })
  })
})

describe('recording usage against a run budget', () => {
  function seed(): { db: OrchestrationDb; runId: string; budgetId: string } {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const task = db.createTask({ spec: 'work' })
    const budget = db.setBudget({
      scope: 'run',
      runId: task.run_id,
      caps: { maxTokens: 1000 }
    })
    return { db, runId: task.run_id, budgetId: budget.id }
  }

  it('makes a token cap enforceable that was inert before', () => {
    const { db, runId } = seed()
    db.setBudget({ scope: 'run', runId, caps: { maxTokens: 50 } })
    const second = db.createTask({ spec: 'second' })

    // Under the cap: the spawn goes through.
    recordRunUsageAgainstBudget({
      db,
      runId,
      usage: [usage({ totalTokens: 10 })],
      source: 'claude-usage'
    })
    expect(() =>
      db.createDispatchContext(second.id, 'term_a', 'tab_a:11111111-1111-4111-8111-111111111111')
    ).not.toThrow()

    // Past it: the next one is refused.
    recordRunUsageAgainstBudget({
      db,
      runId,
      usage: [usage({ totalTokens: 500 })],
      source: 'claude-usage'
    })
    const third = db.createTask({ spec: 'third' })
    expect(() =>
      db.createDispatchContext(third.id, 'term_b', 'tab_b:22222222-2222-4222-8222-222222222222')
    ).toThrow(/tokens used 500 of 50/)
  })

  // The collector reports a total for the window; accumulating deltas would
  // double-count the same transcripts on a rescan.
  it('replaces the observation rather than accumulating it', () => {
    const { db, runId, budgetId } = seed()
    for (const tokens of [100, 100, 100]) {
      recordRunUsageAgainstBudget({
        db,
        runId,
        usage: [usage({ totalTokens: tokens })],
        source: 's'
      })
    }
    expect(db.getBudgetObservation(budgetId)?.observed_tokens).toBe(100)
  })

  it('falls back to the global ceiling when the run has no budget of its own', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const task = db.createTask({ spec: 'work' })
    const global = db.setBudget({ scope: 'global', caps: { maxTokens: 10 } })
    const result = recordRunUsageAgainstBudget({
      db,
      runId: task.run_id,
      usage: [usage({ totalTokens: 7 })],
      source: 'claude-usage'
    })
    expect(result.recorded).toBe(true)
    expect(db.getBudgetObservation(global.id)?.observed_tokens).toBe(7)
  })

  it('records nothing when there is no budget, and says so', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const task = db.createTask({ spec: 'work' })
    expect(
      recordRunUsageAgainstBudget({
        db,
        runId: task.run_id,
        usage: [usage({})],
        source: 's'
      })
    ).toEqual({ recorded: false, sample: null })
  })

  it('records nothing when every provider was unmeasurable', () => {
    const { db, runId, budgetId } = seed()
    const result = recordRunUsageAgainstBudget({
      db,
      runId,
      usage: [usage({ status: 'unavailable' }), usage({ status: 'unavailable' })],
      source: 's'
    })
    expect(result.recorded).toBe(false)
    expect(db.getBudgetObservation(budgetId)).toBeUndefined()
  })
})
