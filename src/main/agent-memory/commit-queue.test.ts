import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMemoryCommitQueue, isGitMissing, type GitRunner } from './commit-queue'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-memory-commits-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeMemory(relative: string, text: string): void {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf-8')
}

function gitLog(): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf-8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

describe('agent memory commit queue over a real repository', () => {
  it('initialises the audit repository on the first commit', async () => {
    writeMemory('wt1/term_a/memory.md', 'first fact')
    const queue = new AgentMemoryCommitQueue(root)

    expect(await queue.enqueue('memory: term_a')).toMatchObject({ status: 'committed' })
    expect(gitLog()).toEqual(['memory: term_a'])
  })

  // Nothing changed is a real, expected outcome — not a failure to report.
  it('reports an unchanged tree as nothing to commit', async () => {
    writeMemory('wt1/term_a/memory.md', 'first fact')
    const queue = new AgentMemoryCommitQueue(root)
    await queue.enqueue('first')

    expect(await queue.enqueue('second')).toEqual({ status: 'nothing-to-commit' })
    expect(gitLog()).toEqual(['first'])
  })

  // The whole reason this class exists: git's index lock is process-global, so
  // overlapping commits corrupt each other. Every commit must land, in order.
  it('serialises concurrent commits instead of letting them overlap', async () => {
    const queue = new AgentMemoryCommitQueue(root)
    const enqueued = [1, 2, 3, 4, 5].map((n) => {
      writeMemory(`wt1/term_${n}/memory.md`, `fact ${n}`)
      return queue.enqueue(`memory ${n}`)
    })

    const outcomes = await Promise.all(enqueued)
    for (const outcome of outcomes) {
      expect(['committed', 'nothing-to-commit']).toContain(outcome.status)
    }
    // git log is newest-first; the queue must have run them in submission order.
    const subjects = gitLog().toReversed()
    expect(subjects[0]).toBe('memory 1')
    expect(subjects).toEqual(subjects.toSorted((a, b) => a.localeCompare(b)))
  })

  it('records the memory file itself, so the audit trail is diffable', async () => {
    writeMemory('wt1/term_a/memory.md', 'the build uses pnpm')
    const queue = new AgentMemoryCommitQueue(root)
    await queue.enqueue('memory: term_a')

    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf-8' })
    expect(tracked).toContain('wt1/term_a/memory.md')
  })
})

describe('agent memory commit queue degradation', () => {
  // Not every workspace has git, and memory must still work — just without an
  // audit trail. That is a reported outcome, never a thrown error.
  it('reports git being absent as unavailable rather than failing', async () => {
    const missing: GitRunner = () => Promise.reject(new Error('spawn git ENOENT'))
    const queue = new AgentMemoryCommitQueue(root, missing)

    expect(await queue.enqueue('memory')).toMatchObject({ status: 'unavailable' })
  })

  it('retries a transient failure with backoff before giving up', async () => {
    let calls = 0
    const flaky: GitRunner = (args) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: '.git', stderr: '' })
      }
      calls += 1
      return calls < 3
        ? Promise.reject(new Error('fatal: Unable to create index.lock: File exists'))
        : Promise.resolve({ stdout: '', stderr: '' })
    }
    // status must report a change or the commit short-circuits before retrying.
    const runner: GitRunner = (args, cwd) =>
      args[0] === 'status'
        ? Promise.resolve({ stdout: ' M wt1/term_a/memory.md', stderr: '' })
        : flaky(args, cwd)

    const queue = new AgentMemoryCommitQueue(root, runner)
    expect(await queue.enqueue('memory')).toMatchObject({ status: 'committed', attempts: 3 })
  })

  it('reports a persistent failure without throwing at the caller', async () => {
    const broken: GitRunner = (args) =>
      args[0] === 'rev-parse'
        ? Promise.resolve({ stdout: '.git', stderr: '' })
        : Promise.reject(new Error('fatal: something is deeply wrong'))
    const queue = new AgentMemoryCommitQueue(root, broken)

    const outcome = await queue.enqueue('memory')
    expect(outcome).toMatchObject({ status: 'failed', attempts: 3 })
    expect(outcome.status === 'failed' && outcome.reason).toContain('deeply wrong')
  })

  // One failed audit write must not wedge every later one.
  it('keeps accepting work after a failure', async () => {
    const runner = vi.fn<GitRunner>((args) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: '.git', stderr: '' })
      }
      return Promise.reject(new Error('fatal: transient'))
    })
    const queue = new AgentMemoryCommitQueue(root, runner)

    expect(await queue.enqueue('first')).toMatchObject({ status: 'failed' })
    expect(await queue.enqueue('second')).toMatchObject({ status: 'failed' })
  })
})

describe('isGitMissing', () => {
  it('separates a missing binary from a commit that went wrong', () => {
    expect(isGitMissing('spawn git ENOENT')).toBe(true)
    expect(isGitMissing("'git' is not recognized as an internal command")).toBe(true)
    expect(isGitMissing('fatal: Unable to create index.lock')).toBe(false)
  })
})
