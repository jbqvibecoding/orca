/** Where a task sits in its workflow. A side table: see the comment on `task_phases`. */
import type { WorkflowPhaseId } from '../../../../../shared/workflow-phase'
import type { OrchestrationDb } from '../orchestration-db'

export type TaskPhaseOrigin = 'project' | 'global' | 'builtin'

export type TaskPhaseRow = {
  task_id: string
  workflow_name: string
  workflow_origin: TaskPhaseOrigin
  phase: WorkflowPhaseId
  cycle: number
  entered_at: string
  /**
   * Modification time the phase's artifact already had when this phase was
   * entered, or null when it did not exist. Compared against the artifact's
   * current time to tell "written during this pass" from "left over from the
   * last one" — a same-host comparison, so no clock skew and no reliance on
   * filesystem timestamp granularity.
   */
  entry_artifact_ms: number | null
  /** Resolved when the phase was entered, so dispatch reads one row instead of the document. */
  instruction: string | null
  artifact: string | null
  last_refusal_cause: string | null
  last_refusal_reason: string | null
}

export function startTaskPhase(
  this: OrchestrationDb,
  args: {
    taskId: string
    workflowName: string
    workflowOrigin: TaskPhaseOrigin
    phase: WorkflowPhaseId
    instruction?: string | null
    artifact?: string | null
    entryArtifactMs?: number | null
  }
): void {
  // Why REPLACE: restarting a task's workflow is a legitimate operation and
  // resets the cycle counter along with any recorded refusal.
  this.db
    .prepare(
      `INSERT OR REPLACE INTO task_phases
         (task_id, workflow_name, workflow_origin, phase, cycle, entered_at, entry_artifact_ms,
          instruction, artifact)
       VALUES (?, ?, ?, ?, 0, datetime('now'), ?, ?, ?)`
    )
    .run(
      args.taskId,
      args.workflowName,
      args.workflowOrigin,
      args.phase,
      args.entryArtifactMs ?? null,
      args.instruction ?? null,
      args.artifact ?? null
    )
}

export function getTaskPhase(this: OrchestrationDb, taskId: string): TaskPhaseRow | undefined {
  return this.db.prepare('SELECT * FROM task_phases WHERE task_id = ?').get(taskId) as
    | TaskPhaseRow
    | undefined
}

export function listTaskPhases(this: OrchestrationDb, phase?: WorkflowPhaseId): TaskPhaseRow[] {
  const sql = phase
    ? 'SELECT * FROM task_phases WHERE phase = ? ORDER BY entered_at'
    : 'SELECT * FROM task_phases ORDER BY entered_at'
  const statement = this.db.prepare(sql)
  return (phase ? statement.all(phase) : statement.all()) as TaskPhaseRow[]
}

/** Move a task into `phase`, clearing the refusal recorded against the phase it left. */
export function enterTaskPhase(
  this: OrchestrationDb,
  args: {
    taskId: string
    phase: WorkflowPhaseId
    cycle: number
    instruction?: string | null
    artifact?: string | null
    entryArtifactMs?: number | null
  }
): void {
  this.db
    .prepare(
      `UPDATE task_phases
         SET phase = ?, cycle = ?, entered_at = datetime('now'), entry_artifact_ms = ?,
             instruction = ?, artifact = ?,
             last_refusal_cause = NULL, last_refusal_reason = NULL
       WHERE task_id = ?`
    )
    .run(
      args.phase,
      args.cycle,
      args.entryArtifactMs ?? null,
      args.instruction ?? null,
      args.artifact ?? null,
      args.taskId
    )
}

/**
 * Record why a phase did not advance, so `workflow status` can report it without
 * re-running the check. The cause is kept beside the sentence because the two
 * are read by different consumers: tooling branches on the cause, people read
 * the reason.
 */
export function recordTaskPhaseRefusal(
  this: OrchestrationDb,
  args: { taskId: string; cause: string; reason: string }
): void {
  this.db
    .prepare(
      'UPDATE task_phases SET last_refusal_cause = ?, last_refusal_reason = ? WHERE task_id = ?'
    )
    .run(args.cause, args.reason, args.taskId)
}

export function clearTaskPhase(this: OrchestrationDb, taskId: string): void {
  this.db.prepare('DELETE FROM task_phases WHERE task_id = ?').run(taskId)
}

export type TaskPhaseStoreMethods = {
  startTaskPhase: typeof startTaskPhase
  getTaskPhase: typeof getTaskPhase
  listTaskPhases: typeof listTaskPhases
  enterTaskPhase: typeof enterTaskPhase
  recordTaskPhaseRefusal: typeof recordTaskPhaseRefusal
  clearTaskPhase: typeof clearTaskPhase
}

export function attachTaskPhaseStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    startTaskPhase,
    getTaskPhase,
    listTaskPhases,
    enterTaskPhase,
    recordTaskPhaseRefusal,
    clearTaskPhase
  })
}
