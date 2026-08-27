// The phase vocabulary a workflow document is written against.
//
// A phase is orthogonal to `TaskStatus`: status is the execution lifecycle of
// one dispatch (`pending` -> `dispatched` -> `completed`), while a phase is
// where the task sits in its workflow. A task can be `completed` for its
// planning dispatch and still owe a running phase, so the two never share a
// column.

export const WORKFLOW_PHASES = ['research', 'planning', 'running', 'review'] as const
export type WorkflowPhaseId = (typeof WORKFLOW_PHASES)[number]

export function isWorkflowPhaseId(value: unknown): value is WorkflowPhaseId {
  return typeof value === 'string' && (WORKFLOW_PHASES as readonly string[]).includes(value)
}

export type WorkflowTemplateValues = {
  task: string
  taskId: string
  phase: string
}

// Why a table and one pass: substituting sequentially lets a value that itself
// contains `{phase}` be rewritten by a later replacement. A task description is
// arbitrary user text, so that is reachable, not theoretical.
export function substituteWorkflowTemplate(text: string, values: WorkflowTemplateValues): string {
  return text.replace(/\{(task_id|task|phase)\}/g, (_full, key: string) => {
    if (key === 'task') {
      return values.task
    }
    return key === 'task_id' ? values.taskId : values.phase
  })
}

/**
 * How a phase may be entered, derived from the document rather than declared.
 *
 * The rule is about the predecessor's artifact, not about the instruction text.
 * agtx derives this from whether the prompt carries `{task}`, because there the
 * prompt typed into the pane is the only channel a worker has — a phase whose
 * prompt omits the task literally cannot start cold. Orca's dispatch preamble
 * always carries the task, so that test would mark every phase startable and
 * mean nothing. What actually gates a phase here is whether the phase declared
 * before it promised a file this one reads.
 */
export type WorkflowPhaseGate =
  | { kind: 'entry' }
  | { kind: 'requires-predecessor'; predecessor: WorkflowPhaseId; artifact: string }

export function resolveWorkflowPhaseGate(
  predecessor: { phase: WorkflowPhaseId; artifact: string | null } | null
): WorkflowPhaseGate {
  if (predecessor === null || predecessor.artifact === null) {
    return { kind: 'entry' }
  }
  return {
    kind: 'requires-predecessor',
    predecessor: predecessor.phase,
    artifact: predecessor.artifact
  }
}
