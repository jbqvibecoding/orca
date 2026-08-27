import { describe, expect, it } from 'vitest'
import { parseWorkflowDocument, type WorkflowDocument } from '../../shared/workflow-document'
import { evaluatePhaseTransition, resolveEntryPhase } from './phase-transition'
import type { WorkflowArtifactCheck } from './workflow-artifact-check'

function documentOf(yaml: string): WorkflowDocument {
  const parsed = parseWorkflowDocument(yaml)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.document
}

const LINEAR = documentOf(`
name: linear
phases:
  planning:
    instruction: "Plan: {task}"
    artifact: .orca/plan.md
  running:
    instruction: Execute the plan.
    artifact: .orca/execute.md
    accepts: [test]
`)

const CYCLIC = documentOf(`
name: cyclic
cycle_to: planning
phases:
  research:
    instruction: "Research: {task}"
    artifact: .orca/research.md
  planning:
    instruction: Plan it.
    artifact: .orca/plan.md
  review:
    instruction: Review it.
    artifact: .orca/review.md
`)

const present: WorkflowArtifactCheck = {
  status: 'present',
  path: '.orca/plan.md',
  modifiedAtMs: 2_000
}

describe('resolveEntryPhase', () => {
  it('picks the first phase the document declares', () => {
    expect(resolveEntryPhase(LINEAR)).toBe('planning')
    expect(resolveEntryPhase(CYCLIC)).toBe('research')
  })

  // Phases are declared sparsely: a workflow may skip research entirely.
  it('starts at the first declared phase, not the first in the vocabulary', () => {
    const document = documentOf(
      'name: b\nphases:\n  running:\n    instruction: Execute the plan.\n'
    )
    expect(resolveEntryPhase(document)).toBe('running')
  })

  it('gates a sparse workflow on the phase it actually declares before', () => {
    const document = documentOf(
      'name: c\nphases:\n  research:\n    artifact: .orca/research.md\n  review:\n    artifact: .orca/review.md\n'
    )
    expect(document.phases.review?.gate).toEqual({
      kind: 'requires-predecessor',
      predecessor: 'research',
      artifact: '.orca/research.md'
    })
  })
})

describe('evaluatePhaseTransition', () => {
  it('advances when the artifact is present and no gate is declared', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'planning',
        cycle: 0,
        artifact: present,
        acceptance: null
      })
    ).toEqual({ kind: 'advance', from: 'planning', to: 'running', cycle: 0 })
  })

  it('finishes at the last phase of a non-cyclic workflow', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'running',
        cycle: 0,
        artifact: present,
        acceptance: 'passed'
      })
    ).toEqual({ kind: 'finished', from: 'running', cycle: 0 })
  })

  it('loops to the declared cycle target and increments the counter', () => {
    expect(
      evaluatePhaseTransition({
        document: CYCLIC,
        from: 'review',
        cycle: 1,
        artifact: present,
        acceptance: null
      })
    ).toEqual({ kind: 'advance', from: 'review', to: 'planning', cycle: 2 })
  })

  it('refuses while the artifact is not written', () => {
    const decision = evaluatePhaseTransition({
      document: LINEAR,
      from: 'planning',
      cycle: 0,
      artifact: { status: 'absent' },
      acceptance: null
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })
  })

  // A host that stopped answering did not prove the phase unfinished.
  it('separates an unreachable artifact from a missing one', () => {
    const decision = evaluatePhaseTransition({
      document: LINEAR,
      from: 'planning',
      cycle: 0,
      artifact: { status: 'unreachable', reason: 'SSH host build-01 is not connected' },
      acceptance: null
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'artifact-unverifiable' })
    expect(decision.kind === 'refused' && decision.reason).toContain('build-01')
  })

  it('refuses a failed acceptance gate and names the checks', () => {
    const decision = evaluatePhaseTransition({
      document: LINEAR,
      from: 'running',
      cycle: 0,
      artifact: present,
      acceptance: 'failed'
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'acceptance-failed' })
    expect(decision.kind === 'refused' && decision.reason).toContain('test')
  })

  // The distinction P1a exists to preserve: unverifiable is not failed, and it
  // is not passed either.
  it('refuses an unverifiable acceptance gate with its own cause', () => {
    const decision = evaluatePhaseTransition({
      document: LINEAR,
      from: 'running',
      cycle: 0,
      artifact: present,
      acceptance: 'unverifiable'
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'acceptance-unverifiable' })
    expect(decision.kind === 'refused' && decision.reason).toContain('not the same as passing')
  })

  it('refuses when a declared gate has not run at all', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'running',
        cycle: 0,
        artifact: present,
        acceptance: null
      })
    ).toMatchObject({ kind: 'refused', cause: 'acceptance-unverifiable' })
  })

  it('advances on a waiver, which only a human can set', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'running',
        cycle: 0,
        artifact: present,
        acceptance: 'failed',
        acceptanceWaived: true
      })
    ).toEqual({ kind: 'finished', from: 'running', cycle: 0 })
  })

  // Cheaper to say "not finished" than to spend a test run finding out.
  it('checks the artifact before the acceptance gate', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'running',
        cycle: 0,
        artifact: { status: 'absent' },
        acceptance: 'failed'
      })
    ).toMatchObject({ cause: 'artifact-missing' })
  })

  // A cyclic pass must not advance on the artifact its previous pass wrote.
  it('treats an unchanged artifact as not written during this pass', () => {
    const decision = evaluatePhaseTransition({
      document: LINEAR,
      from: 'planning',
      cycle: 1,
      artifact: { status: 'present', path: '.orca/plan.md', modifiedAtMs: 1_000 },
      entryArtifactMs: 1_000,
      acceptance: null
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })
    expect(decision.kind === 'refused' && decision.reason).toContain('earlier pass')
  })

  it('accepts an artifact rewritten since the phase was entered', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'planning',
        cycle: 1,
        artifact: { status: 'present', path: '.orca/plan.md', modifiedAtMs: 9_000 },
        entryArtifactMs: 1_000,
        acceptance: null
      })
    ).toMatchObject({ kind: 'advance' })
  })

  // An absent capability must not deadlock a phase forever.
  it('accepts an artifact whose host cannot report a modification time', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'planning',
        cycle: 1,
        artifact: { status: 'present', path: '.orca/plan.md', modifiedAtMs: null },
        entryArtifactMs: 1_000,
        acceptance: null
      })
    ).toMatchObject({ kind: 'advance' })
  })

  it('refuses a phase the workflow does not declare', () => {
    expect(
      evaluatePhaseTransition({
        document: LINEAR,
        from: 'review',
        cycle: 0,
        artifact: present,
        acceptance: null
      })
    ).toMatchObject({ kind: 'refused', cause: 'phase-not-declared' })
  })

  it('advances a phase with no artifact declared', () => {
    const document = documentOf(
      'name: a\ncycle_to: planning\nphases:\n  planning:\n    instruction: "Do: {task}"\n'
    )
    expect(
      evaluatePhaseTransition({
        document,
        from: 'planning',
        cycle: 0,
        artifact: null,
        acceptance: null
      })
    ).toEqual({ kind: 'advance', from: 'planning', to: 'planning', cycle: 1 })
  })
})
