import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasAppEnvironment } from '../../shared/app-environment'
import { commitAgentMemory, resetAgentMemoryCommitQueues } from './audit-commit'
import { dispatchMemoryKey } from './dispatch-memory'
import { getAgentMemoryRoot, replaceAgentMemory } from './memory-store'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-memory-audit-'))
  resetAgentMemoryCommitQueues()
})
afterEach(() => {
  resetAgentMemoryCommitQueues()
  rmSync(userDataPath, { recursive: true, force: true })
})

function gitLog(): string[] {
  return execFileSync('git', ['log', '--format=%s'], {
    cwd: getAgentMemoryRoot(userDataPath),
    encoding: 'utf-8'
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

async function record(text: string): Promise<void> {
  await replaceAgentMemory({
    key: dispatchMemoryKey({ worktree: '/repo', agentHandle: 'term_a' }),
    text,
    userDataPath
  })
}

describe('agent memory audit commits', () => {
  it('records what an agent learned, under the reason given', async () => {
    await record('the build uses pnpm')
    expect(
      await commitAgentMemory('memory: task_a research -> planning', userDataPath)
    ).toMatchObject({ status: 'committed' })
    expect(gitLog()).toEqual(['memory: task_a research -> planning'])
  })

  it('leaves a diffable history across phases', async () => {
    await record('first')
    await commitAgentMemory('memory: task_a research -> planning', userDataPath)
    await record('first\nsecond')
    await commitAgentMemory('memory: task_a planning -> running', userDataPath)

    expect(gitLog()).toHaveLength(2)
    const diff = execFileSync('git', ['show', '--format=', '--unified=0', 'HEAD'], {
      cwd: getAgentMemoryRoot(userDataPath),
      encoding: 'utf-8'
    })
    expect(diff).toContain('+second')
  })

  // Same queue per root, or the concurrent index.lock corruption comes back.
  it('serialises concurrent checkpoints through one queue', async () => {
    await record('a')
    const outcomes = await Promise.all([
      commitAgentMemory('first', userDataPath),
      commitAgentMemory('second', userDataPath),
      commitAgentMemory('third', userDataPath)
    ])
    for (const outcome of outcomes) {
      expect(['committed', 'nothing-to-commit']).toContain(outcome.status)
    }
    expect(gitLog()).toEqual(['first'])
  })

  // A checkpoint that has nothing new is the common case, not a problem.
  it('reports an unchanged store as nothing to commit', async () => {
    await record('settled')
    await commitAgentMemory('first', userDataPath)
    expect(await commitAgentMemory('second', userDataPath)).toEqual({
      status: 'nothing-to-commit'
    })
  })

  // Without an app environment there is no userData to resolve. getAppEnvironment
  // throws by design, so a phase advance in a plain-Node fork would take that
  // throw if the guard were missing. Cleared through the module's own realm slot
  // because that is exactly what hasAppEnvironment() reads.
  it('reports no app environment as unavailable rather than throwing', async () => {
    const slot = globalThis as unknown as Record<symbol, unknown>
    const key = Symbol.for('orca.host.appEnvironment')
    const installed = slot[key]
    slot[key] = null
    try {
      expect(hasAppEnvironment()).toBe(false)
      expect(await commitAgentMemory('memory: task_a')).toMatchObject({ status: 'unavailable' })
    } finally {
      slot[key] = installed
    }
  })

  // The common case at a phase boundary on a task whose agents wrote nothing.
  it('reports an empty store as nothing to commit, not as a failure', async () => {
    expect(await commitAgentMemory('memory: task_a', userDataPath)).toEqual({
      status: 'nothing-to-commit'
    })
  })
})
