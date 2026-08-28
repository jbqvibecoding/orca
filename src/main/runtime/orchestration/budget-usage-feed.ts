// Turns measured usage into the observations a budget enforces against.
//
// Without this, token and spend caps would be inert: the claim reads
// budget_observations, and nothing else writes there. It is deliberately a
// separate step from the claim, because measurement and enforcement run on
// different clocks -- the collector scans vendor transcripts after the work, so
// what it reports is always the past.
//
// Reuses AutomationRunUsage rather than defining a parallel shape, including its
// `unavailable` status: a provider that could not be measured must not be
// recorded as having spent nothing.

import { MICROS_PER_USD } from '../../../shared/budget-cap'
import type { AutomationRunUsage } from '../../../shared/automations-types'
import type { OrchestrationDb } from './db'

export type BudgetUsageSample = {
  tokens: number
  spendMicros: number
}

/**
 * Reads one usage record into a sample, or null when it says nothing usable.
 *
 * `unavailable` yields null rather than zero. Recording an unmeasurable run as
 * zero spend would let a budget drift further from reality on every failed
 * measurement, and silently.
 */
export function sampleFromUsage(usage: AutomationRunUsage): BudgetUsageSample | null {
  if (usage.status !== 'known') {
    return null
  }
  const tokens = usage.totalTokens
  const cost = usage.estimatedCostUsd
  if (tokens === null && cost === null) {
    return null
  }
  return {
    tokens: tokens ?? 0,
    // Rounded to micros at the boundary so no float reaches the database.
    spendMicros: cost === null ? 0 : Math.round(cost * MICROS_PER_USD)
  }
}

export function addSamples(samples: readonly BudgetUsageSample[]): BudgetUsageSample {
  return samples.reduce(
    (total, sample) => ({
      tokens: total.tokens + sample.tokens,
      spendMicros: total.spendMicros + sample.spendMicros
    }),
    { tokens: 0, spendMicros: 0 }
  )
}

/**
 * Records the run's measured usage against its budget.
 *
 * Absolute, not incremental: the collector reports a total for the window, and
 * accumulating deltas would double-count a rescan of the same transcripts.
 */
export function recordRunUsageAgainstBudget(args: {
  db: OrchestrationDb
  runId: string
  usage: readonly AutomationRunUsage[]
  source: string
}): { recorded: boolean; sample: BudgetUsageSample | null } {
  const budget = args.db.getBudgetForRun(args.runId) ?? args.db.getGlobalBudget()
  if (!budget) {
    return { recorded: false, sample: null }
  }
  const samples = args.usage
    .map(sampleFromUsage)
    .filter((sample): sample is BudgetUsageSample => sample !== null)
  if (samples.length === 0) {
    return { recorded: false, sample: null }
  }
  const total = addSamples(samples)
  args.db.recordBudgetObservation({
    budgetId: budget.id,
    tokens: total.tokens,
    spendMicros: total.spendMicros,
    source: args.source
  })
  return { recorded: true, sample: total }
}
