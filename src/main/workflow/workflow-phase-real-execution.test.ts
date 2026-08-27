// Drives a phase chain end to end over a real workspace: real files on disk,
// the real local workspace reader, the real precheck runner, and a real
// orchestration database.
//
// The injected-dependency tests prove the decision table; this one proves the
// parts they stub out actually behave that way — that a file written to disk is
// seen, and that a real non-zero exit code stops the advance.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAutomationPrecheck } from '../automations/precheck-runner'
import { runAcceptanceGate } from '../acceptance/gate-runner'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  resolveWorkspaceFileReader,
  type WorkspaceFileReader
} from '../workspace/workspace-file-reader'
import { advanceTaskWorkflow, startTaskWorkflow } from './workflow-task-service'

const WORKFLOW = `
name: probe
phases:
  planning:
    instruction: Plan it.
    artifact: .orca/plan.md
  running:
    instruction: Build it.
    artifact: .orca/execute.md
    accepts: [test]
`

let dir: string
let db: OrchestrationDb
let reader: WorkspaceFileReader
let taskId: string

function write(relativePath: string, content: string): void {
  const absolute = join(dir, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

function manifest(scripts: Record<string, string>): void {
  write('package.json', JSON.stringify({ name: 'probe', scripts }))
}

async function advance() {
  return advanceTaskWorkflow({
    db,
    taskId,
    workspace: reader,
    lookup: { workspace: reader },
    runAcceptance: async (checks) =>
      (
        await runAcceptanceGate({
          cwd: dir,
          hostId: 'local',
          checks,
          runPrecheck: runAutomationPrecheck
        })
      ).verdict
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-workflow-real-'))
  write('.orca/workflows/probe.yaml', WORKFLOW)
  const resolution = resolveWorkspaceFileReader({ cwd: dir, hostId: 'local' })
  if (resolution.status !== 'ready') {
    throw new Error(resolution.reason)
  }
  reader = resolution.reader
  db = new OrchestrationDb(':memory:')
  taskId = db.createTask({ spec: 'probe task' }).id
  await startTaskWorkflow({
    db,
    taskId,
    workflowName: 'probe',
    workspace: reader,
    lookup: { workspace: reader }
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('workflow phases over a real workspace', () => {
  it('walks the chain, blocking on a real missing file and a real failing check', async () => {
    manifest({ test: 'exit 0' })

    // Planning: nothing written yet.
    expect(await advance()).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })

    write('.orca/plan.md', '# plan\n')
    expect(await advance()).toEqual({
      kind: 'advance',
      from: 'planning',
      to: 'running',
      cycle: 0
    })

    // Running: artifact still missing, so the gate must not have run yet.
    expect(await advance()).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })

    write('.orca/execute.md', '# done\n')
    expect(await advance()).toEqual({ kind: 'finished', from: 'running', cycle: 0 })
  }, 120_000)

  it('stops the advance on a real non-zero exit code', async () => {
    manifest({ test: 'exit 1' })
    write('.orca/plan.md', '# plan\n')
    await advance()
    write('.orca/execute.md', '# done\n')

    const decision = await advance()
    expect(decision).toMatchObject({ kind: 'refused', cause: 'acceptance-failed' })
    expect(db.getTaskPhase(taskId)).toMatchObject({
      phase: 'running',
      last_refusal_cause: 'acceptance-failed'
    })
  }, 120_000)

  // A workspace with no such script is not a failing workspace.
  it('treats a workflow whose check has no script as passing that phase', async () => {
    manifest({ build: 'exit 0' })
    write('.orca/plan.md', '# plan\n')
    await advance()
    write('.orca/execute.md', '# done\n')
    expect(await advance()).toEqual({ kind: 'finished', from: 'running', cycle: 0 })
  }, 120_000)

  // The whole point of the entry snapshot: pass two must not advance on the file
  // pass one wrote. Exercised against real mtimes, where the wall-clock version
  // of this rule broke on coarse filesystem timestamps.
  it('does not accept a real leftover artifact on the next pass of a cycle', async () => {
    write(
      '.orca/workflows/probe.yaml',
      'name: probe\ncycle_to: planning\nphases:\n  planning:\n    instruction: Plan it.\n    artifact: .orca/plan.md\n'
    )
    write('.orca/plan.md', '# pass one\n')
    expect(await advance()).toEqual({ kind: 'advance', from: 'planning', to: 'planning', cycle: 1 })

    // Same file, untouched: the second pass has produced nothing.
    expect(await advance()).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })

    write('.orca/plan.md', '# pass two\n')
    expect(await advance()).toEqual({ kind: 'advance', from: 'planning', to: 'planning', cycle: 2 })
  }, 120_000)

  it('finds an artifact through a real wildcard directory listing', async () => {
    write(
      '.orca/workflows/probe.yaml',
      'name: probe\nphases:\n  planning:\n    instruction: Plan it.\n    artifact: reports/*/plan.md\n'
    )
    write('reports/02-second/plan.md', '# plan\n')
    expect(await advance()).toEqual({ kind: 'finished', from: 'planning', cycle: 0 })
  }, 120_000)
})
