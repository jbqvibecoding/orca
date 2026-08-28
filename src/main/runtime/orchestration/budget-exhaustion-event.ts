// Records a refused spawn on the event log.
//
// ADR-0009 calls exhaustion "an honest stop": the run stops, the partial state
// is recorded, and it is reported. A refusal that left no trace would be
// indistinguishable afterwards from a silent continue, which is the failure this
// whole phase exists to prevent.

import type { BudgetDimension } from '../../../shared/budget-cap'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { createOrchestrationEvent } from '../../observability/orchestration-event-log'
import type { OrchestrationEventSink } from '../../observability/orchestration-event-log'

export type BudgetExhaustion = {
  runId: string
  taskId: string
  budgetId: string
  scope: 'run' | 'global'
  dimension: BudgetDimension
  observed: number
  cap: number
  reason: string
  workspaceId?: string | null
  hostId?: string
}

/**
 * Reads a refusal back off the error the claim threw. Returns null for any other
 * failure, so a real dispatch bug is never quietly reported as a budget stop.
 */
export function describeExhaustedSpawn(
  error: unknown,
  context: {
    db: OrchestrationDb
    taskId: string
    runId: string
  }
): BudgetExhaustion | null {
  if (!(error instanceof OrchestrationError) || error.code !== 'budget_exhausted') {
    return null
  }
  const verdict = context.db.checkSpawnBudget(context.runId)
  if (verdict.status !== 'refused') {
    // The cap was raised between the refusal and this read. Report it with what
    // the error itself carries rather than inventing numbers.
    return null
  }
  return {
    runId: context.runId,
    taskId: context.taskId,
    budgetId: verdict.budgetId,
    scope: verdict.scope,
    dimension: verdict.refusal.dimension,
    observed: verdict.refusal.observed,
    cap: verdict.refusal.cap,
    reason: error.message
  }
}

/**
 * Writes one `budget.exhausted` event. The payload carries what was already
 * spent, not just that a limit was hit — the partial state is the part an
 * operator needs to decide whether to raise the cap or stop.
 */
export function recordBudgetExhaustion(
  emit: OrchestrationEventSink,
  exhaustion: BudgetExhaustion
): void {
  emit(
    createOrchestrationEvent({
      sid: exhaustion.runId,
      kind: 'budget.exhausted',
      attribution: {
        runId: exhaustion.runId,
        workspaceId: exhaustion.workspaceId ?? null,
        hostId: exhaustion.hostId ?? 'local',
        budgetId: exhaustion.budgetId
      },
      payload: {
        taskId: exhaustion.taskId,
        scope: exhaustion.scope,
        dimension: exhaustion.dimension,
        observed: exhaustion.observed,
        cap: exhaustion.cap,
        reason: exhaustion.reason,
        // Spawn counts are exact; the other two are what the last usage scan
        // saw, so a reader must not treat them as the moment's true spend.
        exact: exhaustion.dimension === 'spawns'
      }
    })
  )
}
