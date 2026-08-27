// Binds a task to a workflow document and moves it between phases.
//
// The acceptance gate is injected rather than imported so this module stays free
// of the Electron and SSH graph the precheck runner pulls in, and so the whole
// decision path is testable without running a real typecheck.

import type { AcceptanceCheckName, AcceptanceVerdict } from '../../shared/acceptance-gate'
import { ORCA_YAML_FILE_NAME, parseOrcaYaml } from '../../shared/orca-yaml'
import {
  isValidWorkflowArtifactPattern,
  type WorkflowDocument
} from '../../shared/workflow-document'
import { substituteWorkflowTemplate, type WorkflowPhaseId } from '../../shared/workflow-phase'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { TaskPhaseRow } from '../runtime/orchestration/db/tasks/task-phase-store'
import type { WorkspaceFileReader } from '../workspace/workspace-file-reader'
import { checkWorkflowArtifact, type WorkflowArtifactCheck } from './workflow-artifact-check'
import {
  evaluatePhaseTransition,
  isStaleArtifact,
  resolveEntryPhase,
  type PhaseTransitionDecision
} from './phase-transition'
import {
  resolveWorkflowDocument,
  type WorkflowDocumentLookup,
  type WorkflowDocumentOrigin
} from './workflow-document-source'

export type WorkflowTaskStatus = {
  taskId: string
  workflow: string
  origin: WorkflowDocumentOrigin
  phase: WorkflowPhaseId
  cycle: number
  enteredAt: string
  artifact: string | null
  /** `none` when the phase declares no artifact; the rest mirror the workspace read. */
  artifactStatus: 'present' | 'absent' | 'unreachable' | 'none'
  accepts: readonly AcceptanceCheckName[]
  lastRefusal: { cause: string; reason: string } | null
}

export type AcceptanceGateRun = (
  checks: readonly AcceptanceCheckName[]
) => Promise<AcceptanceVerdict>

function requirePhaseRow(db: OrchestrationDb, taskId: string): TaskPhaseRow {
  const row = db.getTaskPhase(taskId)
  if (!row) {
    throw new OrchestrationError(
      'workflow_not_started',
      `Task ${taskId} is not running a workflow. Start one with: orca workflow start --task ${taskId} --workflow <name>`
    )
  }
  return row
}

async function requireDocument(
  name: string,
  lookup: WorkflowDocumentLookup
): Promise<{ document: WorkflowDocument; origin: WorkflowDocumentOrigin }> {
  const resolution = await resolveWorkflowDocument(name, lookup)
  if (resolution.status === 'resolved') {
    return { document: resolution.document, origin: resolution.origin }
  }
  if (resolution.status === 'invalid') {
    throw new OrchestrationError(
      'workflow_invalid',
      `Workflow "${name}" (${resolution.origin}) could not be used: ${resolution.error}`
    )
  }
  if (resolution.status === 'unreachable') {
    throw new OrchestrationError(
      'workflow_unreachable',
      `Could not read the project workflow library: ${resolution.reason}`
    )
  }
  throw new OrchestrationError(
    'workflow_not_found',
    `No workflow named "${name}". Searched: ${resolution.searched.join(', ') || 'builtins only'}`
  )
}

/**
 * One definition of what a phase's artifact path resolves to. Both the entry
 * snapshot and the later check go through here, so they can never disagree
 * about which file the phase promised.
 */
function resolveArtifactPath(
  document: WorkflowDocument,
  phase: WorkflowPhaseId,
  taskId: string
): string | null {
  const pattern = document.phases[phase]?.artifact ?? null
  if (pattern === null) {
    return null
  }
  // `{task}` is rejected at parse time, so the empty value here is never reached.
  const resolved = substituteWorkflowTemplate(pattern, { task: '', taskId, phase })
  // Re-validate after substitution: the pattern was safe, the substituted values
  // are ids, and a separator arriving through one of them would widen the path.
  if (!isValidWorkflowArtifactPattern(resolved)) {
    throw new OrchestrationError(
      'workflow_invalid',
      `Artifact "${pattern}" resolved to "${resolved}", which is not a workspace-relative path.`
    )
  }
  return resolved
}

async function checkPhaseArtifact(
  document: WorkflowDocument,
  phase: WorkflowPhaseId,
  taskId: string,
  workspace: WorkspaceFileReader
): Promise<{ pattern: string | null; check: WorkflowArtifactCheck | null }> {
  const resolved = resolveArtifactPath(document, phase, taskId)
  return resolved === null
    ? { pattern: null, check: null }
    : { pattern: resolved, check: await checkWorkflowArtifact(workspace, resolved) }
}

function describeArtifactStatus(
  check: WorkflowArtifactCheck | null,
  entryArtifactMs: number | null
): WorkflowTaskStatus['artifactStatus'] {
  if (check === null) {
    return 'none'
  }
  return isStaleArtifact(check, entryArtifactMs) ? 'absent' : check.status
}

/**
 * What gets stored on the phase row when a task enters `phase`: the text a
 * worker is given, and the artifact's modification time right now, which is the
 * baseline a later check compares against.
 */
async function phaseEntryRecord(
  document: WorkflowDocument,
  phase: WorkflowPhaseId,
  taskId: string,
  workspace: WorkspaceFileReader
): Promise<{
  instruction: string | null
  artifact: string | null
  entryArtifactMs: number | null
}> {
  const declared = document.phases[phase]
  const artifact = resolveArtifactPath(document, phase, taskId)
  const existing = artifact === null ? null : await checkWorkflowArtifact(workspace, artifact)
  return {
    instruction: declared?.instruction
      ? substituteWorkflowTemplate(declared.instruction, { task: '', taskId, phase })
      : null,
    artifact,
    entryArtifactMs: existing?.status === 'present' ? existing.modifiedAtMs : null
  }
}

/** The workflow a repo pins in its `orca.yaml`, or null when it pins none. */
export async function readRepoDefaultWorkflowName(
  workspace: WorkspaceFileReader
): Promise<string | null> {
  const read = await workspace.readFile(ORCA_YAML_FILE_NAME)
  return read.status === 'read' ? (parseOrcaYaml(read.content)?.workflow ?? null) : null
}

export async function startTaskWorkflow(args: {
  db: OrchestrationDb
  taskId: string
  workflowName: string | null
  workspace: WorkspaceFileReader
  lookup: WorkflowDocumentLookup
}): Promise<{ phase: WorkflowPhaseId; origin: WorkflowDocumentOrigin; workflow: string }> {
  if (!args.db.getTask(args.taskId)) {
    throw new OrchestrationError('task_not_found', `No task ${args.taskId}.`)
  }
  const name = args.workflowName ?? (await readRepoDefaultWorkflowName(args.workspace))
  if (name === null) {
    throw new OrchestrationError(
      'workflow_not_specified',
      'No workflow given and this repo pins none. Pass --workflow, or set `workflow: <name>` in orca.yaml.'
    )
  }
  const { document, origin } = await requireDocument(name, args.lookup)
  const phase = resolveEntryPhase(document)
  if (!phase) {
    throw new OrchestrationError(
      'workflow_invalid',
      `Workflow "${document.name}" declares no phase a task can start in.`
    )
  }
  args.db.startTaskPhase({
    taskId: args.taskId,
    workflowName: document.name,
    workflowOrigin: origin,
    phase,
    // Resolved here so dispatch reads one row rather than re-resolving the
    // document on its hot path; a mid-phase edit reaches the task at its next
    // transition, not retroactively.
    ...(await phaseEntryRecord(document, phase, args.taskId, args.workspace))
  })
  return { phase, origin, workflow: document.name }
}

export async function readTaskWorkflowStatus(args: {
  db: OrchestrationDb
  taskId: string
  workspace: WorkspaceFileReader
  lookup: WorkflowDocumentLookup
}): Promise<WorkflowTaskStatus> {
  const row = requirePhaseRow(args.db, args.taskId)
  const { document } = await requireDocument(row.workflow_name, args.lookup)
  const artifact = await checkPhaseArtifact(document, row.phase, args.taskId, args.workspace)
  return {
    taskId: args.taskId,
    workflow: row.workflow_name,
    origin: row.workflow_origin,
    phase: row.phase,
    cycle: row.cycle,
    enteredAt: row.entered_at,
    artifact: artifact.pattern,
    // Why the same staleness rule as advance: reporting a leftover file as
    // "written" would tell the user a phase can advance when it cannot.
    artifactStatus: describeArtifactStatus(artifact.check, row.entry_artifact_ms),
    accepts: document.phases[row.phase]?.accepts ?? [],
    lastRefusal:
      row.last_refusal_cause && row.last_refusal_reason
        ? { cause: row.last_refusal_cause, reason: row.last_refusal_reason }
        : null
  }
}

export async function advanceTaskWorkflow(args: {
  db: OrchestrationDb
  taskId: string
  workspace: WorkspaceFileReader
  lookup: WorkflowDocumentLookup
  runAcceptance: AcceptanceGateRun
  waiveAcceptance?: boolean
}): Promise<PhaseTransitionDecision> {
  const row = requirePhaseRow(args.db, args.taskId)
  const { document } = await requireDocument(row.workflow_name, args.lookup)
  const artifact = await checkPhaseArtifact(document, row.phase, args.taskId, args.workspace)

  // Why the gate runs only once the artifact is there: a phase that has not
  // finished should not spend a test run to be told it has not finished.
  const checks = document.phases[row.phase]?.accepts ?? []
  const artifactSettled = artifact.check === null || artifact.check.status === 'present'
  const needsGate = checks.length > 0 && args.waiveAcceptance !== true && artifactSettled
  const verdict = needsGate ? await args.runAcceptance(checks) : null

  const decision = evaluatePhaseTransition({
    document,
    from: row.phase,
    cycle: row.cycle,
    artifact: artifact.check,
    entryArtifactMs: row.entry_artifact_ms,
    acceptance: verdict,
    acceptanceWaived: args.waiveAcceptance
  })

  if (decision.kind === 'refused') {
    args.db.recordTaskPhaseRefusal({
      taskId: args.taskId,
      cause: decision.cause,
      reason: decision.reason
    })
    return decision
  }
  if (decision.kind === 'advance') {
    args.db.enterTaskPhase({
      taskId: args.taskId,
      phase: decision.to,
      cycle: decision.cycle,
      ...(await phaseEntryRecord(document, decision.to, args.taskId, args.workspace))
    })
  }
  return decision
}
