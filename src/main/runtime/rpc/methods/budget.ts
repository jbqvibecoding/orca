import { z } from 'zod'
import { MICROS_PER_USD } from '../../../../shared/budget-cap'
import { defineMethod, type RpcMethod } from '../core'

// A cap is a whole number or null (uncapped). Money arrives as USD because that
// is what a person types, and is stored as micros because that is what survives
// arithmetic.
const Cap = z.number().int().min(0).nullable().optional()

const BudgetScope = z.object({ runId: z.string().min(1).nullable().default(null) })

const SetBudget = BudgetScope.extend({
  maxSpawns: Cap,
  maxTokens: Cap,
  maxSpendUsd: z.number().min(0).nullable().optional()
})

function usdToMicros(usd: number | null | undefined): number | null {
  return usd === null || usd === undefined ? null : Math.round(usd * MICROS_PER_USD)
}

export const BUDGET_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: 'budget.show',
    params: BudgetScope.partial(),
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const budgets = (params.runId ? [db.getBudgetForRun(params.runId)] : db.listBudgets())
        .filter((budget) => budget !== undefined)
        .map((budget) => {
          const observation = db.getBudgetObservation(budget.id)
          return {
            id: budget.id,
            scope: budget.scope,
            runId: budget.run_id,
            maxSpawns: budget.max_spawns,
            maxTokens: budget.max_tokens,
            maxSpendMicros: budget.max_spend_micros,
            // Counted from dispatch rows, so exact — unlike the two below.
            usedSpawns: db.countBudgetSpawns(budget.id),
            observedTokens: observation?.observed_tokens ?? 0,
            observedSpendMicros: observation?.observed_spend_micros ?? 0,
            observedAt: observation?.observed_at ?? null
          }
        })
      return { budgets }
    }
  }),
  defineMethod({
    name: 'budget.set',
    params: SetBudget,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const budget = db.setBudget({
        scope: params.runId === null ? 'global' : 'run',
        ...(params.runId === null ? {} : { runId: params.runId }),
        caps: {
          maxSpawns: params.maxSpawns ?? null,
          maxTokens: params.maxTokens ?? null,
          maxSpendMicros: usdToMicros(params.maxSpendUsd)
        }
      })
      return { budgetId: budget.id, scope: budget.scope, runId: budget.run_id }
    }
  }),
  defineMethod({
    name: 'budget.clear',
    params: BudgetScope.partial(),
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const runId = params.runId ?? null
      return { cleared: db.clearBudget(runId === null ? { scope: 'global' } : { runId }) }
    }
  })
]
