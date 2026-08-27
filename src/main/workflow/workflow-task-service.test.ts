import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcceptanceCheckName, AcceptanceVerdict } from '../../shared/acceptance-gate'
import { OrchestrationDb } from '../runtime/orchestration/db'
import type {
  WorkspaceDirectoryRead,
  WorkspaceFileRead,
  WorkspaceFileReader
} from '../workspace/workspace-file-reader'
import {
  advanceTaskWorkflow,
  readTaskWorkflowStatus,
  startTaskWorkflow
} from './workflow-task-service'

const DOCUMENT = `
name: standard
cycle_to: planning
phases:
  planning:
    instruction: Plan it.
    artifact: .orca/plan.md
  running:
    instruction: Build it.
    artifact: .orca/execute.md
    accepts: [test]
`

function workspaceOf(args: {
  present?: readonly string[]
  unreachable?: readonly string[]
  documents?: Readonly<Record<string, string>>
}): WorkspaceFileReader {
  const present = new Set(args.present ?? [])
  const unreachable = new Set(args.unreachable ?? [])
  return {
    readFile: async (path): Promise<WorkspaceFileRead> => {
      const content = args.documents?.[path]
      return content === undefined ? { status: 'absent' } : { status: 'read', content }
    },
    fileExists: async (path) => {
      if (unreachable.has(path)) {
        return { status: 'unreachable', reason: 'SSH host build-01 is not connected' }
      }
      return present.has(path)
        ? { status: 'present', modifiedAtMs: Date.now() }
        : { status: 'absent' }
    },
    readDirectory: async (): Promise<WorkspaceDirectoryRead> => ({ status: 'absent' })
  }
}

const PROJECT_LIBRARY = { '.orca/workflows/standard.yaml': DOCUMENT }

describe('workflow task service', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function setup(workspace: WorkspaceFileReader) {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const task = db.createTask({ spec: 'build the thing' })
    return { db, taskId: task.id, workspace, lookup: { workspace } }
  }

  async function start(context: ReturnType<typeof setup>) {
    return startTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workflowName: 'standard',
      workspace: context.workspace,
      lookup: context.lookup
    })
  }

  const gate = (verdict: AcceptanceVerdict) =>
    vi.fn(async (_checks: readonly AcceptanceCheckName[]) => verdict)

  it('starts a task at the first phase and records where the document came from', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    expect(await start(context)).toEqual({
      phase: 'planning',
      origin: 'project',
      workflow: 'standard'
    })
    expect(context.db.getTaskPhase(context.taskId)).toMatchObject({
      workflow_name: 'standard',
      workflow_origin: 'project',
      phase: 'planning'
    })
  })

  it('refuses to start a workflow on a task that does not exist', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await expect(
      startTaskWorkflow({
        db: context.db,
        taskId: 'task_missing',
        workflowName: 'standard',
        workspace: context.workspace,
        lookup: context.lookup
      })
    ).rejects.toThrow(/No task/)
  })

  it('tells the caller how to start a workflow when a task has none', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await expect(
      readTaskWorkflowStatus({
        db: context.db,
        taskId: context.taskId,
        workspace: context.workspace,
        lookup: context.lookup
      })
    ).rejects.toThrow(/orca workflow start/)
  })

  it('reports the phase and that its artifact is not written yet', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await start(context)
    const status = await readTaskWorkflowStatus({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup
    })
    expect(status).toMatchObject({
      phase: 'planning',
      artifact: '.orca/plan.md',
      artifactStatus: 'absent',
      accepts: []
    })
  })

  it('advances once the artifact exists', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY, present: ['.orca/plan.md'] }))
    await start(context)
    const decision = await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance: gate('passed')
    })
    expect(decision).toEqual({ kind: 'advance', from: 'planning', to: 'running', cycle: 0 })
    expect(context.db.getTaskPhase(context.taskId)?.phase).toBe('running')
  })

  it('records the refusal so status can report it without re-checking', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await start(context)
    await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance: gate('passed')
    })
    expect(context.db.getTaskPhase(context.taskId)).toMatchObject({
      phase: 'planning',
      last_refusal_cause: 'artifact-missing'
    })
  })

  // A test run is expensive; a phase that has not finished should not pay for one.
  it('does not run the acceptance gate while the artifact is missing', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await start(context)
    context.db.enterTaskPhase({ taskId: context.taskId, phase: 'running', cycle: 0 })
    const runAcceptance = gate('passed')
    await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance
    })
    expect(runAcceptance).not.toHaveBeenCalled()
  })

  it('runs the gate with exactly the checks the phase declares', async () => {
    const context = setup(
      workspaceOf({ documents: PROJECT_LIBRARY, present: ['.orca/execute.md'] })
    )
    await start(context)
    context.db.enterTaskPhase({ taskId: context.taskId, phase: 'running', cycle: 0 })
    const runAcceptance = gate('passed')
    await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance
    })
    expect(runAcceptance).toHaveBeenCalledWith(['test'])
  })

  it('blocks the advance on a failed gate and stays in the phase', async () => {
    const context = setup(
      workspaceOf({ documents: PROJECT_LIBRARY, present: ['.orca/execute.md'] })
    )
    await start(context)
    context.db.enterTaskPhase({ taskId: context.taskId, phase: 'running', cycle: 0 })
    const decision = await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance: gate('failed')
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'acceptance-failed' })
    expect(context.db.getTaskPhase(context.taskId)?.phase).toBe('running')
  })

  // Losing contact with the host is not evidence that the phase is unfinished.
  it('refuses on an unreachable artifact without calling it missing', async () => {
    const context = setup(
      workspaceOf({ documents: PROJECT_LIBRARY, unreachable: ['.orca/plan.md'] })
    )
    await start(context)
    const decision = await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance: gate('passed')
    })
    expect(decision).toMatchObject({ kind: 'refused', cause: 'artifact-unverifiable' })
  })

  it('loops back and increments the cycle at the end of a cyclic workflow', async () => {
    const context = setup(
      workspaceOf({ documents: PROJECT_LIBRARY, present: ['.orca/execute.md'] })
    )
    await start(context)
    context.db.enterTaskPhase({ taskId: context.taskId, phase: 'running', cycle: 0 })
    const decision = await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance: gate('passed')
    })
    expect(decision).toEqual({ kind: 'advance', from: 'running', to: 'planning', cycle: 1 })
    expect(context.db.getTaskPhase(context.taskId)?.cycle).toBe(1)
  })

  it('skips the gate on a waiver but still requires the artifact', async () => {
    const context = setup(workspaceOf({ documents: PROJECT_LIBRARY }))
    await start(context)
    context.db.enterTaskPhase({ taskId: context.taskId, phase: 'running', cycle: 0 })
    const runAcceptance = gate('failed')
    const decision = await advanceTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workspace: context.workspace,
      lookup: context.lookup,
      runAcceptance,
      waiveAcceptance: true
    })
    expect(runAcceptance).not.toHaveBeenCalled()
    expect(decision).toMatchObject({ kind: 'refused', cause: 'artifact-missing' })
  })

  it('falls back to a builtin document when the project declares none', async () => {
    const context = setup(workspaceOf({}))
    const started = await startTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workflowName: 'standard',
      workspace: context.workspace,
      lookup: context.lookup
    })
    expect(started.origin).toBe('builtin')
  })

  it('falls back to the workflow the repo pins in orca.yaml', async () => {
    const context = setup(workspaceOf({ documents: { 'orca.yaml': 'workflow: standard-terse\n' } }))
    const started = await startTaskWorkflow({
      db: context.db,
      taskId: context.taskId,
      workflowName: null,
      workspace: context.workspace,
      lookup: context.lookup
    })
    expect(started).toMatchObject({ workflow: 'standard-terse', origin: 'builtin' })
  })

  it('says what to do when neither a flag nor orca.yaml names a workflow', async () => {
    const context = setup(workspaceOf({}))
    await expect(
      startTaskWorkflow({
        db: context.db,
        taskId: context.taskId,
        workflowName: null,
        workspace: context.workspace,
        lookup: context.lookup
      })
    ).rejects.toThrow(/orca\.yaml/)
  })

  it('reports an unknown workflow by name', async () => {
    const context = setup(workspaceOf({}))
    await expect(
      startTaskWorkflow({
        db: context.db,
        taskId: context.taskId,
        workflowName: 'nope',
        workspace: context.workspace,
        lookup: context.lookup
      })
    ).rejects.toThrow(/No workflow named "nope"/)
  })
})
