import { describe, expect, it } from 'vitest'
import {
  isWorkflowPhaseId,
  resolveWorkflowPhaseGate,
  substituteWorkflowTemplate,
  WORKFLOW_PHASES
} from './workflow-phase'

describe('phase vocabulary', () => {
  it('is the canonical order', () => {
    expect(WORKFLOW_PHASES).toEqual(['research', 'planning', 'running', 'review'])
  })

  it('recognizes only declared phases', () => {
    expect(isWorkflowPhaseId('planning')).toBe(true)
    expect(isWorkflowPhaseId('deploying')).toBe(false)
    expect(isWorkflowPhaseId(null)).toBe(false)
  })
})

describe('substituteWorkflowTemplate', () => {
  it('replaces every placeholder', () => {
    expect(
      substituteWorkflowTemplate('{phase} of {task_id}: {task}', {
        task: 'fix the deadlock',
        taskId: 't-1',
        phase: 'planning'
      })
    ).toBe('planning of t-1: fix the deadlock')
  })

  // A task description is arbitrary user text, so a sequential replace would let
  // it be rewritten by a later substitution.
  it('does not re-substitute a value that itself looks like a placeholder', () => {
    expect(
      substituteWorkflowTemplate('{task}', { task: '{phase}', taskId: 't-1', phase: 'review' })
    ).toBe('{phase}')
  })

  it('leaves unknown placeholders alone', () => {
    expect(
      substituteWorkflowTemplate('{cycle}', { task: 'a', taskId: 'b', phase: 'running' })
    ).toBe('{cycle}')
  })

  it('distinguishes {task} from {task_id}', () => {
    expect(
      substituteWorkflowTemplate('{task_id}', { task: 'desc', taskId: 't-9', phase: 'running' })
    ).toBe('t-9')
  })
})

describe('resolveWorkflowPhaseGate', () => {
  it('treats the first declared phase as an entry point', () => {
    expect(resolveWorkflowPhaseGate(null)).toEqual({ kind: 'entry' })
  })

  it('gates a phase on the artifact its predecessor promised', () => {
    expect(resolveWorkflowPhaseGate({ phase: 'planning', artifact: '.orca/plan.md' })).toEqual({
      kind: 'requires-predecessor',
      predecessor: 'planning',
      artifact: '.orca/plan.md'
    })
  })

  // Nothing to wait for: a predecessor that promises no file cannot be observed
  // to have finished, so gating on it would block forever.
  it('treats a phase whose predecessor promises nothing as an entry point', () => {
    expect(resolveWorkflowPhaseGate({ phase: 'planning', artifact: null })).toEqual({
      kind: 'entry'
    })
  })
})
