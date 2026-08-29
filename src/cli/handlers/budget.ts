import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalNumberFlag,
  getOptionalStringFlag
} from '../flags'
import { MICROS_PER_USD } from '../../shared/budget-cap'

type BudgetView = {
  id: string
  scope: 'run' | 'global'
  runId: string | null
  maxSpawns: number | null
  maxTokens: number | null
  maxSpendMicros: number | null
  usedSpawns: number
  observedTokens: number
  observedSpendMicros: number
  observedAt: string | null
}

function usd(micros: number): string {
  return `$${(micros / MICROS_PER_USD).toFixed(2)}`
}

function capLine(label: string, used: string, cap: string | null): string {
  return `  ${label.padEnd(8)} ${used}${cap === null ? ' (uncapped)' : ` of ${cap}`}`
}

function formatBudgets(value: { budgets: BudgetView[] }): string {
  if (value.budgets.length === 0) {
    return 'No budgets set. Nothing limits how much these agents can spend.'
  }
  return value.budgets
    .map((budget) => {
      const title = budget.scope === 'global' ? 'global ceiling' : `run ${budget.runId}`
      const lines = [
        title,
        capLine('spawns', String(budget.usedSpawns), budget.maxSpawns?.toString() ?? null),
        capLine('tokens', String(budget.observedTokens), budget.maxTokens?.toString() ?? null),
        capLine(
          'spend',
          usd(budget.observedSpendMicros),
          budget.maxSpendMicros === null ? null : usd(budget.maxSpendMicros)
        )
      ]
      // Saying when the lagging figures were measured is the difference between
      // a number and a number someone can act on.
      // Never leave a cap looking live when nothing feeds it: a user who set
      // --max-tokens and saw no warning would reasonably believe it applies.
      const capped = budget.maxTokens !== null || budget.maxSpendMicros !== null
      if (budget.observedAt === null) {
        lines.push(
          capped
            ? '  NOTE: spawn count is enforced. Nothing measures tokens or spend yet, so those caps do not fire.'
            : '  spawn count is exact; tokens and spend have not been measured'
        )
      } else {
        lines.push(`  tokens and spend measured ${budget.observedAt}; spawn count is exact`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function scopeParams(flags: Map<string, string | boolean>): { runId: string | null } {
  return { runId: getOptionalStringFlag(flags, 'run') ?? null }
}

export const BUDGET_HANDLERS: Record<string, CommandHandler> = {
  'budget show': async ({ flags, client, json }) => {
    printResult(
      await client.call<{ budgets: BudgetView[] }>('budget.show', scopeParams(flags)),
      json,
      formatBudgets
    )
  },

  'budget set': async ({ flags, client, json }) => {
    const result = await client.call<{ budgetId: string; scope: string; runId: string | null }>(
      'budget.set',
      {
        ...scopeParams(flags),
        maxSpawns: getOptionalNonNegativeIntegerFlag(flags, 'max-spawns') ?? null,
        maxTokens: getOptionalNonNegativeIntegerFlag(flags, 'max-tokens') ?? null,
        maxSpendUsd: getOptionalNumberFlag(flags, 'max-spend-usd') ?? null
      }
    )
    const inertCap =
      getOptionalNonNegativeIntegerFlag(flags, 'max-tokens') !== undefined ||
      getOptionalNumberFlag(flags, 'max-spend-usd') !== undefined
    printResult(result, json, (value) => {
      const scope =
        value.scope === 'global'
          ? 'Global ceiling set. It applies on top of every run budget.'
          : `Budget set for run ${value.runId}.`
      // Recording a cap that cannot fire and saying nothing would be the
      // worst outcome here: it reads as protection that is not there.
      return inertCap
        ? `${scope}\n\nNOTE: the spawn cap is enforced, but nothing measures tokens or spend yet,\nso those caps are recorded and will not refuse anything.`
        : scope
    })
  },

  'budget clear': async ({ flags, client, json }) => {
    const result = await client.call<{ cleared: boolean }>('budget.clear', scopeParams(flags))
    printResult(result, json, (value) =>
      value.cleared ? 'Budget cleared; nothing caps this now.' : 'There was no budget to clear.'
    )
  }
}
