// The six routes ADR-0009 asks for, and nothing else.
//
// Every response shape is explicit rather than a row spread: a database row is
// an internal record, and letting one leak onto the wire makes any later column
// an accidental public field.

import { MICROS_PER_USD } from '../../../shared/budget-cap'
import { TASK_APPROVAL_STATES, type TaskApprovalState } from '../orchestration/types'
import type { OrchestrationDb } from '../orchestration/db'
import type { BudgetRow } from '../orchestration/db/budgets/budget-store'
import { ControlPlaneHttpError, type ControlPlaneRoute } from './control-plane-router'

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ControlPlaneHttpError(400, 'Expected a JSON object.')
  }
  return body as Record<string, unknown>
}

/** A cap is a non-negative integer, `null` to clear it, or absent. Anything else is refused rather than coerced. */
function readCap(source: Record<string, unknown>, field: string): number | null | undefined {
  if (!(field in source)) {
    return undefined
  }
  const value = source[field]
  if (value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ControlPlaneHttpError(400, `${field} must be a non-negative integer or null.`)
  }
  return value
}

function budgetView(db: OrchestrationDb, budget: BudgetRow): Record<string, unknown> {
  const observation = db.getBudgetObservation(budget.id)
  return {
    id: budget.id,
    scope: budget.scope,
    runId: budget.run_id,
    caps: {
      maxSpawns: budget.max_spawns,
      maxTokens: budget.max_tokens,
      maxSpendMicros: budget.max_spend_micros
    },
    observed: {
      // Spawns are counted from dispatch rows and are exact. The other two are
      // whatever the last usage scan saw, so the reader is told when that was
      // rather than being handed three numbers that look equally current.
      tokens: observation?.observed_tokens ?? 0,
      spendMicros: observation?.observed_spend_micros ?? 0,
      observedAt: observation?.observed_at ?? null,
      source: observation?.source ?? null
    },
    microsPerUsd: MICROS_PER_USD
  }
}

function taskView(row: {
  id: string
  run_id: string
  parent_id: string | null
  task_title: string | null
  status: string
  approval_state: TaskApprovalState
  approved_by: string | null
  approved_at: string | null
  created_at: string
  completed_at: string | null
}): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    // ADR-0009's goal ancestry: the chain that says why this task exists.
    parentId: row.parent_id,
    title: row.task_title,
    status: row.status,
    approval: {
      state: row.approval_state,
      by: row.approved_by,
      at: row.approved_at
    },
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

export function createControlPlaneRoutes(getDb: () => OrchestrationDb): ControlPlaneRoute[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/tasks',
      handle: ({ query }) => {
        const db = getDb()
        const runId = query.get('run')
        const tasks = db.listTasks(runId ? { runId } : undefined)
        return { tasks: tasks.map(taskView) }
      }
    },
    {
      method: 'GET',
      pattern: '/v1/tasks/:id',
      handle: ({ params }) => {
        const task = getDb().getTask(params.id as string)
        if (!task) {
          throw new ControlPlaneHttpError(404, 'not_found')
        }
        return { task: taskView(task) }
      }
    },
    {
      method: 'GET',
      pattern: '/v1/budgets',
      handle: () => {
        const db = getDb()
        return { budgets: db.listBudgets().map((budget) => budgetView(db, budget)) }
      }
    },
    {
      // PUT states the whole budget: an omitted dimension is cleared, not kept.
      // A partial update would make "no cap" and "unchanged" indistinguishable.
      method: 'PUT',
      pattern: '/v1/budgets/:scope',
      handle: ({ params, body }) => {
        const db = getDb()
        const scope = params.scope
        if (scope !== 'run' && scope !== 'global') {
          throw new ControlPlaneHttpError(404, 'not_found')
        }
        const payload = asRecord(body)
        const runId = payload.runId
        if (scope === 'run' && typeof runId !== 'string') {
          throw new ControlPlaneHttpError(400, 'A run-scoped budget needs a runId.')
        }
        const budget = db.setBudget({
          scope,
          ...(scope === 'run' ? { runId: runId as string } : {}),
          caps: {
            maxSpawns: readCap(payload, 'maxSpawns') ?? null,
            maxTokens: readCap(payload, 'maxTokens') ?? null,
            maxSpendMicros: readCap(payload, 'maxSpendMicros') ?? null
          }
        })
        return { budget: budgetView(db, budget) }
      }
    },
    {
      method: 'GET',
      pattern: '/v1/approvals',
      handle: ({ query }) => {
        const db = getDb()
        const state = query.get('state') ?? 'pending'
        if (!(TASK_APPROVAL_STATES as readonly string[]).includes(state)) {
          throw new ControlPlaneHttpError(400, `Unknown approval state ${JSON.stringify(state)}.`)
        }
        const tasks = db
          .listTasks()
          .filter((task) => task.approval_state === state)
          .map(taskView)
        return { approvals: tasks }
      }
    },
    {
      method: 'POST',
      pattern: '/v1/approvals/:taskId',
      handle: ({ params, body }) => {
        const db = getDb()
        const payload = asRecord(body)
        const state = payload.state
        // Only a decision may be posted here: 'not_required' and 'pending' are
        // states the system sets, not verdicts a caller reaches.
        if (state !== 'approved' && state !== 'rejected') {
          throw new ControlPlaneHttpError(400, "state must be 'approved' or 'rejected'.")
        }
        const by = typeof payload.by === 'string' ? payload.by : null
        if (by === null) {
          throw new ControlPlaneHttpError(400, 'by is required: an approval needs an approver.')
        }
        // A missing task is the caller's mistake, not a server fault; letting
        // the store's error fall through would report it as a 500.
        if (!db.getTask(params.taskId as string)) {
          throw new ControlPlaneHttpError(404, 'not_found')
        }
        const task = db.setTaskApproval({ taskId: params.taskId as string, state, by })
        return { task: taskView(task) }
      }
    }
  ]
}
