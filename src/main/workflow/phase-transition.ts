// Decides whether a task may leave its current phase.
//
// Pure: the artifact check and the acceptance verdict are handed in, so the
// whole decision table is unit-testable without a workspace, a host, or a
// dispatched worker.

import type { AcceptanceVerdict } from '../../shared/acceptance-gate'
import {
  orderedWorkflowPhases,
  type WorkflowDocument,
  type WorkflowPhaseDocument
} from '../../shared/workflow-document'
import type { WorkflowPhaseId } from '../../shared/workflow-phase'
import type { WorkflowArtifactCheck } from './workflow-artifact-check'

export type PhaseTransitionDecision =
  | { kind: 'advance'; from: WorkflowPhaseId; to: WorkflowPhaseId; cycle: number }
  | { kind: 'finished'; from: WorkflowPhaseId; cycle: number }
  | { kind: 'refused'; cause: PhaseRefusalCause; reason: string }

/**
 * Why a phase did not advance. `*-unverifiable` is never folded into its
 * `*-missing`/`*-failed` sibling: an unreachable host or a check that never
 * produced an exit code did not prove the phase incomplete, and reporting it as
 * incomplete would turn a dropped connection into a false verdict.
 */
export type PhaseRefusalCause =
  | 'artifact-missing'
  | 'artifact-unverifiable'
  | 'acceptance-failed'
  | 'acceptance-unverifiable'
  | 'phase-not-declared'

export type PhaseTransitionInput = {
  document: WorkflowDocument
  from: WorkflowPhaseId
  cycle: number
  artifact: WorkflowArtifactCheck | null
  /** The artifact's modification time when this phase was entered; null when it did not exist. */
  entryArtifactMs?: number | null
  acceptance: AcceptanceVerdict | null
  /** Set only when a human has explicitly waived the acceptance gate for this transition. */
  acceptanceWaived?: boolean
}

/**
 * The phase a task starts in. Null is unreachable for a parsed document — the
 * parser refuses one with no phases — but the type keeps callers honest if a
 * document is ever built by hand.
 */
export function resolveEntryPhase(document: WorkflowDocument): WorkflowPhaseId | null {
  return orderedWorkflowPhases(document)[0] ?? null
}

function successorPhase(
  document: WorkflowDocument,
  from: WorkflowPhaseId
): { to: WorkflowPhaseId; cycleDelta: number } | null {
  const order = orderedWorkflowPhases(document)
  const index = order.indexOf(from)
  if (index === -1) {
    return null
  }
  if (index < order.length - 1) {
    return { to: order[index + 1], cycleDelta: 0 }
  }
  return document.cycleTo ? { to: document.cycleTo, cycleDelta: 1 } : null
}

/**
 * A cyclic workflow re-enters a phase whose artifact path it already wrote on
 * the previous pass; without this, pass two would advance the moment it started,
 * on evidence pass one produced.
 *
 * The comparison is against the time the same file had when the phase was
 * entered, not against a wall clock: the two readings come from the same host's
 * filesystem, so neither clock skew against an SSH host nor coarse timestamp
 * granularity can make a fresh file look old. A host that reports no time at all
 * counts as fresh — an absent capability must not deadlock a phase.
 */
export function isStaleArtifact(
  check: WorkflowArtifactCheck,
  entryArtifactMs: number | null | undefined
): boolean {
  return (
    check.status === 'present' &&
    entryArtifactMs !== null &&
    entryArtifactMs !== undefined &&
    check.modifiedAtMs !== null &&
    check.modifiedAtMs === entryArtifactMs
  )
}

function artifactRefusal(
  phase: WorkflowPhaseDocument,
  check: WorkflowArtifactCheck | null,
  entryArtifactMs: number | null | undefined
): { cause: PhaseRefusalCause; reason: string } | null {
  if (phase.artifact === null) {
    return null
  }
  if (check !== null && isStaleArtifact(check, entryArtifactMs)) {
    return {
      cause: 'artifact-missing',
      reason: `${phase.artifact} is left over from an earlier pass; this phase has not written it yet.`
    }
  }
  if (check === null || check.status === 'absent') {
    return {
      cause: 'artifact-missing',
      reason: `${phase.artifact} has not been written yet, so this phase is not finished.`
    }
  }
  if (check.status === 'unreachable') {
    return {
      cause: 'artifact-unverifiable',
      reason: `Could not tell whether ${phase.artifact} exists: ${check.reason}.`
    }
  }
  return null
}

function acceptanceRefusal(
  phase: WorkflowPhaseDocument,
  verdict: AcceptanceVerdict | null,
  waived: boolean
): { cause: PhaseRefusalCause; reason: string } | null {
  if (phase.accepts.length === 0 || waived) {
    return null
  }
  const checks = phase.accepts.join(', ')
  if (verdict === null) {
    return {
      cause: 'acceptance-unverifiable',
      reason: `The acceptance gate (${checks}) has not run for this phase yet.`
    }
  }
  if (verdict === 'failed') {
    return { cause: 'acceptance-failed', reason: `The acceptance gate (${checks}) failed.` }
  }
  if (verdict === 'unverifiable') {
    return {
      cause: 'acceptance-unverifiable',
      reason: `The acceptance gate (${checks}) could not be verified, which is not the same as passing it.`
    }
  }
  return null
}

export function evaluatePhaseTransition(input: PhaseTransitionInput): PhaseTransitionDecision {
  const phase = input.document.phases[input.from]
  if (!phase) {
    return {
      kind: 'refused',
      cause: 'phase-not-declared',
      reason: `Workflow "${input.document.name}" does not declare a ${input.from} phase.`
    }
  }

  // Artifact first: an unfinished phase should not spend a test run to be told so.
  const blockedByArtifact = artifactRefusal(phase, input.artifact, input.entryArtifactMs)
  if (blockedByArtifact) {
    return { kind: 'refused', ...blockedByArtifact }
  }
  const blockedByAcceptance = acceptanceRefusal(
    phase,
    input.acceptance,
    input.acceptanceWaived === true
  )
  if (blockedByAcceptance) {
    return { kind: 'refused', ...blockedByAcceptance }
  }

  const successor = successorPhase(input.document, input.from)
  if (!successor) {
    return { kind: 'finished', from: input.from, cycle: input.cycle }
  }
  return {
    kind: 'advance',
    from: input.from,
    to: successor.to,
    cycle: input.cycle + successor.cycleDelta
  }
}
