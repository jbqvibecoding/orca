import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './db/contract-constants'
import { OrchestrationDb } from './db'

describe('task phase side table', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function createDb(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    return database
  }

  it('creates a fresh database at the current schema version', () => {
    const db = createDb()
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(30)
  })

  it('starts a task in a phase and reads it back', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'build the thing' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    const row = db.getTaskPhase(task.id)
    expect(row).toMatchObject({
      task_id: task.id,
      workflow_name: 'standard',
      workflow_origin: 'builtin',
      phase: 'planning',
      cycle: 0
    })
  })

  // A task without a workflow simply has no row; that is not an error state.
  it('reports no row for a task that has no workflow', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'plain task' })
    expect(db.getTaskPhase(task.id)).toBeUndefined()
  })

  it('advances the phase and clears the recorded refusal', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    db.recordTaskPhaseRefusal({
      taskId: task.id,
      cause: 'artifact-missing',
      reason: '.orca/plan.md has not been written yet.'
    })
    expect(db.getTaskPhase(task.id)?.last_refusal_cause).toBe('artifact-missing')

    db.enterTaskPhase({ taskId: task.id, phase: 'running', cycle: 1 })
    const row = db.getTaskPhase(task.id)
    expect(row).toMatchObject({ phase: 'running', cycle: 1 })
    expect(row?.last_refusal_cause).toBeNull()
    expect(row?.last_refusal_reason).toBeNull()
  })

  it('restarts a workflow by resetting the cycle counter', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    db.enterTaskPhase({ taskId: task.id, phase: 'review', cycle: 3 })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard-terse',
      workflowOrigin: 'global',
      phase: 'research'
    })
    expect(db.getTaskPhase(task.id)).toMatchObject({
      workflow_name: 'standard-terse',
      workflow_origin: 'global',
      phase: 'research',
      cycle: 0
    })
  })

  it('lists phases and filters by phase', () => {
    const db = createDb()
    const first = db.createTask({ spec: 'a' })
    const second = db.createTask({ spec: 'b' })
    for (const task of [first, second]) {
      db.startTaskPhase({
        taskId: task.id,
        workflowName: 'standard',
        workflowOrigin: 'builtin',
        phase: 'planning'
      })
    }
    db.enterTaskPhase({ taskId: second.id, phase: 'running', cycle: 0 })
    expect(db.listTaskPhases()).toHaveLength(2)
    expect(db.listTaskPhases('running').map((row) => row.task_id)).toEqual([second.id])
  })

  it('refuses a phase outside the vocabulary', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    expect(() =>
      db.startTaskPhase({
        taskId: task.id,
        workflowName: 'standard',
        workflowOrigin: 'builtin',
        // Deliberately outside WORKFLOW_PHASES: the CHECK constraint is the guard.
        phase: 'deploying' as never
      })
    ).toThrow()
  })

  it('refuses an origin outside the resolution chain', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    expect(() =>
      db.startTaskPhase({
        taskId: task.id,
        workflowName: 'standard',
        workflowOrigin: 'downloaded' as never,
        phase: 'planning'
      })
    ).toThrow()
  })

  it('stores the phase text and the artifact baseline it was entered with', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning',
      instruction: 'Plan it.',
      artifact: '.orca/plan.md',
      entryArtifactMs: 1_700_000_000_000
    })
    expect(db.getTaskPhase(task.id)).toMatchObject({
      instruction: 'Plan it.',
      artifact: '.orca/plan.md',
      entry_artifact_ms: 1_700_000_000_000
    })

    db.enterTaskPhase({
      taskId: task.id,
      phase: 'running',
      cycle: 0,
      instruction: 'Build it.',
      artifact: '.orca/execute.md',
      entryArtifactMs: null
    })
    expect(db.getTaskPhase(task.id)).toMatchObject({
      instruction: 'Build it.',
      artifact: '.orca/execute.md',
      entry_artifact_ms: null
    })
  })

  it('clears a task phase', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    db.clearTaskPhase(task.id)
    expect(db.getTaskPhase(task.id)).toBeUndefined()
  })

  // createTables would recreate the table on any open, so the migration step is
  // driven directly here: it is what converges a database whose stored version
  // predates v30 without depending on that ordering.
  it('recreates the phase table from the v30 migration step alone', () => {
    const db = createDb()
    db.db.exec('DROP TABLE task_phases')
    db.db.pragma('user_version = 29')
    db.migrate()
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    expect(db.getTaskPhase(task.id)?.phase).toBe('planning')
  })

  it('keeps existing tasks when an older database converges to v30', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'pre-existing' })
    db.db.pragma('user_version = 29')
    db.migrate()
    expect(db.getTask(task.id)?.spec).toBe('pre-existing')
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('drops phase rows when orchestration state is reset', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'x' })
    db.startTaskPhase({
      taskId: task.id,
      workflowName: 'standard',
      workflowOrigin: 'builtin',
      phase: 'planning'
    })
    db.resetTasks()
    expect(db.listTaskPhases()).toHaveLength(0)
  })
})
