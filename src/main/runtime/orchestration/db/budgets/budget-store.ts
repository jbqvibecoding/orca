// Reading and writing budgets, and answering "does one more spawn fit".
//
// The resolve-and-check pair is deliberately synchronous and deliberately reads
// only this database: both spawn boundaries call it from inside a write
// transaction they already hold, which is what makes the check and the claim
// atomic (ADR-0009). Anything async here would break that.

import {
  checkBudget,
  isUncapped,
  type BudgetCaps,
  type BudgetDecision,
  type BudgetObserved,
  type BudgetScope
} from '../../../../../shared/budget-cap'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type BudgetRow = {
  id: string
  scope: BudgetScope
  run_id: string | null
  max_spawns: number | null
  max_tokens: number | null
  max_spend_micros: number | null
  created_at: string
  updated_at: string
}

export type BudgetObservationRow = {
  budget_id: string
  observed_tokens: number
  observed_spend_micros: number
  observed_at: string
  source: string | null
}

function toCaps(row: BudgetRow): BudgetCaps {
  return {
    maxSpawns: row.max_spawns,
    maxTokens: row.max_tokens,
    maxSpendMicros: row.max_spend_micros
  }
}

export function listBudgets(this: OrchestrationDb): BudgetRow[] {
  return this.db.prepare('SELECT * FROM budgets ORDER BY scope, created_at').all() as BudgetRow[]
}

export function getBudgetForRun(this: OrchestrationDb, runId: string): BudgetRow | undefined {
  return this.db.prepare('SELECT * FROM budgets WHERE run_id = ?').get(runId) as
    | BudgetRow
    | undefined
}

export function getGlobalBudget(this: OrchestrationDb): BudgetRow | undefined {
  return this.db.prepare("SELECT * FROM budgets WHERE scope = 'global'").get() as
    | BudgetRow
    | undefined
}

export type BudgetCapInput = {
  maxSpawns?: number | null
  maxTokens?: number | null
  maxSpendMicros?: number | null
}

/** Creates or replaces the caps for one scope. Omitted dimensions are cleared, so a PUT is a whole-budget statement. */
export function setBudget(
  this: OrchestrationDb,
  args: { scope: BudgetScope; runId?: string | null; caps: BudgetCapInput }
): BudgetRow {
  const runId = args.scope === 'run' ? (args.runId ?? null) : null
  if (args.scope === 'run' && runId === null) {
    throw new Error('A run-scoped budget needs a run id.')
  }
  const existing =
    args.scope === 'global' ? this.getGlobalBudget() : this.getBudgetForRun(runId as string)
  const id = existing?.id ?? generateId('bgt')
  this.db
    .prepare(
      `INSERT INTO budgets (id, scope, run_id, max_spawns, max_tokens, max_spend_micros)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         max_spawns = excluded.max_spawns,
         max_tokens = excluded.max_tokens,
         max_spend_micros = excluded.max_spend_micros,
         updated_at = datetime('now')`
    )
    .run(
      id,
      args.scope,
      runId,
      args.caps.maxSpawns ?? null,
      args.caps.maxTokens ?? null,
      args.caps.maxSpendMicros ?? null
    )
  return this.db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow
}

/**
 * Records what the usage collector observed. Separate from the caps because it
 * arrives on a different clock: the collector scans vendor transcripts after the
 * work, so this always describes the past.
 */
export function recordBudgetObservation(
  this: OrchestrationDb,
  args: { budgetId: string; tokens: number; spendMicros: number; source: string }
): void {
  this.db
    .prepare(
      `INSERT INTO budget_observations (budget_id, observed_tokens, observed_spend_micros, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(budget_id) DO UPDATE SET
         observed_tokens = excluded.observed_tokens,
         observed_spend_micros = excluded.observed_spend_micros,
         observed_at = datetime('now'),
         source = excluded.source`
    )
    .run(args.budgetId, args.tokens, args.spendMicros, args.source)
}

export function getBudgetObservation(
  this: OrchestrationDb,
  budgetId: string
): BudgetObservationRow | undefined {
  return this.db.prepare('SELECT * FROM budget_observations WHERE budget_id = ?').get(budgetId) as
    | BudgetObservationRow
    | undefined
}

/**
 * Spawns are counted, never stored. Counting the dispatch rows the claim is
 * about to add to keeps one source of truth; a stored counter would drift the
 * moment a dispatch was created or reset by any path that forgot to bump it.
 */
function countSpawns(db: OrchestrationDb, budget: BudgetRow): number {
  const sql =
    budget.scope === 'run'
      ? 'SELECT COUNT(*) AS n FROM dispatch_contexts WHERE run_id = ?'
      : 'SELECT COUNT(*) AS n FROM dispatch_contexts'
  const row = (
    budget.scope === 'run' ? db.db.prepare(sql).get(budget.run_id) : db.db.prepare(sql).get()
  ) as { n: number }
  return row.n
}

function observedFor(db: OrchestrationDb, budget: BudgetRow): BudgetObserved {
  const observation = db.getBudgetObservation(budget.id)
  return {
    spawns: countSpawns(db, budget),
    tokens: observation?.observed_tokens ?? 0,
    spendMicros: observation?.observed_spend_micros ?? 0
  }
}

export type BudgetVerdict =
  | { status: 'allowed'; budgetId: string | null }
  | {
      status: 'refused'
      budgetId: string
      scope: BudgetScope
      refusal: Extract<BudgetDecision, { allowed: false }>
    }

/**
 * Checks the run budget, then the global one. Both must allow.
 *
 * MUST be called from inside the caller's write transaction — that is the whole
 * point. A check outside it is a check separate from the claim, which
 * double-spends under exactly the parallelism this product creates.
 */
export function checkSpawnBudget(this: OrchestrationDb, runId: string | null): BudgetVerdict {
  const candidates = [
    runId === null ? undefined : this.getBudgetForRun(runId),
    this.getGlobalBudget()
  ].filter((budget): budget is BudgetRow => budget !== undefined)

  // The run budget is the one a spawn is attributed to when both allow; a global
  // ceiling is a backstop, not the thing this work is being charged to.
  let attribution: string | null = null
  for (const budget of candidates) {
    if (attribution === null && budget.scope === 'run') {
      attribution = budget.id
    }
    if (isUncapped(toCaps(budget))) {
      continue
    }
    const decision = checkBudget(toCaps(budget), observedFor(this, budget))
    if (!decision.allowed) {
      return { status: 'refused', budgetId: budget.id, scope: budget.scope, refusal: decision }
    }
  }
  return { status: 'allowed', budgetId: attribution ?? candidates[0]?.id ?? null }
}

/** Exact, unlike the stored token and spend observations: counted from the dispatch rows themselves. */
export function countBudgetSpawns(this: OrchestrationDb, budgetId: string): number {
  const budget = this.db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId) as
    | BudgetRow
    | undefined
  return budget ? countSpawns(this, budget) : 0
}

export function clearBudget(
  this: OrchestrationDb,
  target: { scope: 'global' } | { runId: string }
): boolean {
  const existing = 'scope' in target ? this.getGlobalBudget() : this.getBudgetForRun(target.runId)
  if (!existing) {
    return false
  }
  // Drop the observation with the budget. A later budget on the same run gets a
  // fresh id, so a leftover row is never read back -- it just accumulates
  // unreferenced, which is worth avoiding but is not a correctness bug.
  this.db.prepare('DELETE FROM budget_observations WHERE budget_id = ?').run(existing.id)
  this.db.prepare('DELETE FROM budgets WHERE id = ?').run(existing.id)
  return true
}

/**
 * Which budget a spawn on this run is charged to: its own if it has one, else
 * the global ceiling. Attribution only — it makes no allow/refuse judgement,
 * which the claim's SQL predicate already settled.
 */
export function resolveSpawnBudgetId(this: OrchestrationDb, runId: string | null): string | null {
  const run = runId === null ? undefined : this.getBudgetForRun(runId)
  return run?.id ?? this.getGlobalBudget()?.id ?? null
}

export type BudgetStoreMethods = {
  resolveSpawnBudgetId: typeof resolveSpawnBudgetId
  countBudgetSpawns: typeof countBudgetSpawns
  clearBudget: typeof clearBudget
  listBudgets: typeof listBudgets
  getBudgetForRun: typeof getBudgetForRun
  getGlobalBudget: typeof getGlobalBudget
  setBudget: typeof setBudget
  recordBudgetObservation: typeof recordBudgetObservation
  getBudgetObservation: typeof getBudgetObservation
  checkSpawnBudget: typeof checkSpawnBudget
}

export function attachBudgetStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    resolveSpawnBudgetId,
    countBudgetSpawns,
    clearBudget,
    listBudgets,
    getBudgetForRun,
    getGlobalBudget,
    setBudget,
    recordBudgetObservation,
    getBudgetObservation,
    checkSpawnBudget
  })
}
