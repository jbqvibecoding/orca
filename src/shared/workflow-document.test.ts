import { describe, expect, it } from 'vitest'
import { MAX_ORCA_YAML_BYTES } from './orca-yaml-file-limit'
import {
  isValidWorkflowArtifactPattern,
  orderedWorkflowPhases,
  parseWorkflowDocument
} from './workflow-document'

const VALID = `
name: standard
description: Plan, execute, review.
cycle_to: running
phases:
  planning:
    instruction: |
      Plan this task: {task}
    artifact: .orca/plan.md
    accepts: [typecheck]
  running:
    instruction: Execute the plan.
    artifact: .orca/execute.md
`

function expectError(content: string): string {
  const parsed = parseWorkflowDocument(content)
  expect(parsed.ok).toBe(false)
  return parsed.ok ? '' : parsed.error
}

describe('parseWorkflowDocument', () => {
  it('parses a document and derives each phase gate', () => {
    const parsed = parseWorkflowDocument(VALID)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.document.name).toBe('standard')
    expect(parsed.document.cycleTo).toBe('running')
    expect(parsed.document.phases.planning?.gate).toEqual({ kind: 'entry' })
    expect(parsed.document.phases.planning?.accepts).toEqual(['typecheck'])
    expect(parsed.document.phases.running?.gate).toEqual({
      kind: 'requires-predecessor',
      predecessor: 'planning',
      artifact: '.orca/plan.md'
    })
    expect(orderedWorkflowPhases(parsed.document)).toEqual(['planning', 'running'])
  })

  it('defaults cycle_to to null and accepts to empty', () => {
    const parsed = parseWorkflowDocument('name: a\nphases:\n  planning:\n    artifact: p.md\n')
    expect(parsed.ok && parsed.document.cycleTo).toBeNull()
    expect(parsed.ok && parsed.document.phases.planning?.accepts).toEqual([])
  })

  it('rejects a name that is not a usable identifier', () => {
    expect(expectError('name: Not A Name\nphases:\n  planning: {}\n')).toContain('needs a name')
  })

  it('rejects an unknown phase instead of silently dropping it', () => {
    expect(expectError('name: a\nphases:\n  deploying: {}\n')).toContain('is not a phase')
  })

  it('rejects a document with no phases', () => {
    expect(expectError('name: a\nphases: {}\n')).toContain('declares no phases')
  })

  // The allowlist is the point of the acceptance contract.
  it('rejects an acceptance check outside the allowlist and names the allowed ones', () => {
    const error = expectError('name: a\nphases:\n  planning:\n    accepts: [deploy]\n')
    expect(error).toContain('is not an acceptance check')
    expect(error).toContain('typecheck, test, or lint')
  })

  it('deduplicates repeated acceptance checks', () => {
    const parsed = parseWorkflowDocument(
      'name: a\nphases:\n  planning:\n    accepts: [test, test]\n'
    )
    expect(parsed.ok && parsed.document.phases.planning?.accepts).toEqual(['test'])
  })

  it('reports malformed YAML rather than returning nothing', () => {
    expect(expectError('name: [unclosed\n')).toContain('not valid YAML')
  })

  it('rejects a non-mapping document', () => {
    expect(expectError('- one\n- two\n')).toContain('mapping at the top level')
  })

  it('refuses a document beyond the size bound', () => {
    const huge = `name: a\nphases:\n  planning:\n    instruction: "${'x'.repeat(MAX_ORCA_YAML_BYTES)}"\n`
    expect(expectError(huge)).toContain('too large')
  })

  // So a UI can suggest an upgrade instead of reporting a broken document.
  it('keeps unknown keys instead of failing on them', () => {
    const parsed = parseWorkflowDocument(
      'name: a\nfuture: yes\nphases:\n  planning:\n    artifact: p.md\n    future: yes\n'
    )
    expect(parsed.ok && parsed.document.unknownKeys).toEqual(['future', 'phases.planning.future'])
  })
})

describe('artifact patterns', () => {
  it('accepts a workspace-relative path and one whole-segment wildcard', () => {
    expect(isValidWorkflowArtifactPattern('.orca/plan.md')).toBe(true)
    expect(isValidWorkflowArtifactPattern('.planning/phases/*/PLAN.md')).toBe(true)
  })

  // The document is user-authored and its path is joined onto a workspace root,
  // so traversal has to be refused here.
  it('refuses traversal and absolute paths', () => {
    expect(isValidWorkflowArtifactPattern('../outside.md')).toBe(false)
    expect(isValidWorkflowArtifactPattern('/etc/passwd')).toBe(false)
    expect(isValidWorkflowArtifactPattern('C:/Windows/system.ini')).toBe(false)
    expect(isValidWorkflowArtifactPattern('a/./b.md')).toBe(false)
    expect(isValidWorkflowArtifactPattern('..\\outside.md')).toBe(false)
  })

  // Keeps matching a directory listing plus an equality test, with no glob engine.
  it('refuses partial and repeated wildcards', () => {
    expect(isValidWorkflowArtifactPattern('docs/plan-*.md')).toBe(false)
    expect(isValidWorkflowArtifactPattern('*/*/plan.md')).toBe(false)
  })

  it('is rejected by the parser with a message naming the rule', () => {
    expect(expectError('name: a\nphases:\n  planning:\n    artifact: ../escape.md\n')).toContain(
      'workspace-relative'
    )
  })

  it('refuses the task description inside an artifact path', () => {
    expect(expectError('name: a\nphases:\n  planning:\n    artifact: out/{task}.md\n')).toContain(
      'cannot contain {task}'
    )
  })
})
