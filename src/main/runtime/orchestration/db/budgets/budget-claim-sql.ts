// The budget half of a spawn claim, as SQL.
//
// It is a SQL predicate rather than a JavaScript check for two reasons, and the
// second one was learned the hard way:
//
//  1. Atomicity. Folded into the claim's own INSERT, the decision and the claim
//     are one statement, so two parallel spawns cannot both read the same
//     remaining budget and both proceed (ADR-0009).
//
//  2. Lock ordering. A read issued before the first write inside a savepoint
//     takes a SHARED lock, and the later INSERT then has to upgrade it to
//     RESERVED. SQLite fails that upgrade immediately with SQLITE_BUSY when
//     another connection is writing -- the busy handler cannot rescue it -- so a
//     pre-read turns a survivable wait into "database is locked".
//
// `describeBudgetRefusal` explains a refusal afterwards; by then the claim has
// already lost, so reading is safe and costs nothing on the happy path.

/**
 * True when no budget forbids one more spawn for the run named by `runIdColumn`.
 * `runIdColumn` must be a column reference the surrounding statement has in
 * scope (e.g. `tasks.run_id`), not user input.
 */
export function budgetAllowsSpawnSql(runIdColumn: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM budgets b
    LEFT JOIN budget_observations o ON o.budget_id = b.id
    WHERE (b.run_id = ${runIdColumn} OR b.scope = 'global')
      AND (
        (b.max_spawns IS NOT NULL AND (
          SELECT COUNT(*) FROM dispatch_contexts d
          WHERE b.scope = 'global' OR d.run_id = b.run_id
        ) >= b.max_spawns)
        OR (b.max_tokens IS NOT NULL
            AND COALESCE(o.observed_tokens, 0) >= b.max_tokens)
        OR (b.max_spend_micros IS NOT NULL
            AND COALESCE(o.observed_spend_micros, 0) >= b.max_spend_micros)
      )
  )`
}
