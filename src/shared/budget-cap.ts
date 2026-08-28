// What a budget allows, as a pure decision.
//
// Both spawn boundaries — dispatching to an existing terminal and starting a new
// worker — ask the same question, so the rule lives here once rather than in two
// SQL predicates that could drift apart.
//
// ADR-0009: enforcement happens at the spawn boundary. Refusing before work
// starts is the only point that does not waste what it interrupts.

/** Money is integer micros end to end. Floating-point dollars lose cents on the way through. */
export const MICROS_PER_USD = 1_000_000

export const BUDGET_DIMENSIONS = ['spawns', 'tokens', 'spend'] as const
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number]

export const BUDGET_SCOPES = ['run', 'global'] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

/**
 * A null cap means that dimension is uncapped — not zero. Zero is a real cap
 * that refuses everything, and an operator who types 0 means it.
 */
export type BudgetCaps = {
  maxSpawns: number | null
  maxTokens: number | null
  maxSpendMicros: number | null
}

/**
 * What has been used so far.
 *
 * `spawns` is exact: it is counted from the dispatch rows in the same
 * transaction that would create the next one. `tokens` and `spendMicros` come
 * from the usage collector, which scans vendor transcripts after the fact, so
 * they lag by up to one scan. That difference is real and is why the two are
 * documented separately rather than presented as one number.
 */
export type BudgetObserved = {
  spawns: number
  tokens: number
  spendMicros: number
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; dimension: BudgetDimension; observed: number; cap: number }

type DimensionReader = {
  cap: (caps: BudgetCaps) => number | null
  observed: (observed: BudgetObserved) => number
}

// Ordered so the exact dimension is reported first when several are blown at
// once: it is the one the operator can act on without waiting for a rescan.
const DIMENSION_READERS: Record<BudgetDimension, DimensionReader> = {
  spawns: { cap: (caps) => caps.maxSpawns, observed: (o) => o.spawns },
  tokens: { cap: (caps) => caps.maxTokens, observed: (o) => o.tokens },
  spend: { cap: (caps) => caps.maxSpendMicros, observed: (o) => o.spendMicros }
}

/**
 * Decides whether one more spawn fits. Refuses when a dimension is already at
 * its cap, because the spawn being judged has not been counted yet.
 */
export function checkBudget(caps: BudgetCaps, observed: BudgetObserved): BudgetDecision {
  for (const dimension of BUDGET_DIMENSIONS) {
    const reader = DIMENSION_READERS[dimension]
    const cap = reader.cap(caps)
    if (cap === null) {
      continue
    }
    const used = reader.observed(observed)
    if (used >= cap) {
      return { allowed: false, dimension, observed: used, cap }
    }
  }
  return { allowed: true }
}

/** True when nothing is capped — used to skip the budget lookup entirely. */
export function isUncapped(caps: BudgetCaps): boolean {
  return caps.maxSpawns === null && caps.maxTokens === null && caps.maxSpendMicros === null
}

function formatMicros(micros: number): string {
  return `$${(micros / MICROS_PER_USD).toFixed(2)}`
}

/** Names the dimension, what was used, and the cap — a refusal with no reason reads as a bug. */
export function describeBudgetRefusal(
  refusal: Extract<BudgetDecision, { allowed: false }>,
  scope: BudgetScope
): string {
  const label = scope === 'run' ? 'run budget' : 'global budget'
  if (refusal.dimension === 'spend') {
    return `Refused by the ${label}: spend is ${formatMicros(refusal.observed)} of ${formatMicros(refusal.cap)}.`
  }
  const noun = refusal.dimension === 'spawns' ? 'spawns' : 'tokens'
  const lag =
    refusal.dimension === 'tokens'
      ? ' Token counts come from the usage scan and can lag work already in flight.'
      : ''
  return `Refused by the ${label}: ${noun} used ${refusal.observed} of ${refusal.cap}.${lag}`
}
