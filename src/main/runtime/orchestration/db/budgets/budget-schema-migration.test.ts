// Upgrading a v30 database to v31.
//
// The contract fields are the reason this matters: ADR-0009 says approval state
// and budget attribution cannot be backfilled, so an upgraded database has to
// gain the columns without inventing values for rows written before them.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import SyncDatabase from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../../db'
import { SCHEMA_VERSION } from '../contract-constants'

const dirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function sqliteOf(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

/** Builds a database, strips the v31 additions, and stamps it back to v30. */
function v30Database(): { path: string; taskId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-budget-migration-'))
  dirs.push(dir)
  const path = join(dir, 'orchestration.db')

  const seeded = new OrchestrationDb(path)
  const task = seeded.createTask({ spec: 'work that predates budgets' })
  seeded.close()

  const raw = new SyncDatabase(path)
  raw.exec('DROP TABLE IF EXISTS budgets')
  raw.exec('DROP TABLE IF EXISTS budget_observations')
  // SQLite cannot drop a column on older engines, so the columns are left in
  // place; the migration's hasColumn guard is what this exercises.
  raw.pragma('user_version = 30')
  raw.close()
  return { path, taskId: task.id }
}

describe('schema v30 to v31', () => {
  it('brings a v30 database up to the current version', () => {
    const { path } = v30Database()
    const upgraded = new OrchestrationDb(path)
    databases.push(upgraded)
    expect(sqliteOf(upgraded).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('creates the budget tables an upgraded database was missing', () => {
    const { path } = v30Database()
    const upgraded = new OrchestrationDb(path)
    databases.push(upgraded)
    expect(upgraded.listBudgets()).toEqual([])

    const runId = upgraded.getTask(upgraded.listTasks()[0]!.id)!.run_id
    const budget = upgraded.setBudget({ scope: 'run', runId, caps: { maxSpawns: 2 } })
    expect(upgraded.getBudgetForRun(runId)?.id).toBe(budget.id)
  })

  // Rows written before the contract existed get the defaults, which is the
  // honest answer: nobody approved them and no budget was charged.
  it('leaves pre-existing rows at the defaults rather than guessing', () => {
    const { path, taskId } = v30Database()
    const upgraded = new OrchestrationDb(path)
    databases.push(upgraded)

    const task = upgraded.getTask(taskId)
    expect(task?.approval_state).toBe('not_required')
    expect(task?.approved_by).toBeNull()
    expect(task?.approved_at).toBeNull()
  })

  it('adds budget attribution to dispatch rows created after the upgrade', () => {
    const { path, taskId } = v30Database()
    const upgraded = new OrchestrationDb(path)
    databases.push(upgraded)

    upgraded.createDispatchContext(taskId, 'term_a', 'tab_a:11111111-1111-4111-8111-111111111111')
    expect(upgraded.getDispatchContext(taskId)?.budget_id).toBeNull()
  })

  it('is idempotent when reopened', () => {
    const { path } = v30Database()
    new OrchestrationDb(path).close()
    const reopened = new OrchestrationDb(path)
    databases.push(reopened)
    expect(sqliteOf(reopened).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })
})
