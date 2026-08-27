import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchMemoryKey, loadDispatchMemory } from './dispatch-memory'
import { agentMemoryPath, replaceAgentMemory } from './memory-store'
import { checkAgentMemoryKey, UNSCOPED_AGENT_MEMORY_WORKSPACE } from '../../shared/agent-memory'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-dispatch-memory-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('dispatch memory key', () => {
  // Worktree selectors carry `/`, `::` and `:`; a sanitising rewrite could map
  // two worktrees onto one name and silently merge their memory.
  it('turns any worktree selector into a usable path segment', () => {
    for (const selector of ['id:repo::/a/b', '/Users/x/Github/orca', 'C:\\repos\\orca']) {
      const key = dispatchMemoryKey({ worktree: selector, agentHandle: 'term_a' })
      expect(checkAgentMemoryKey(key)).toEqual({ ok: true })
    }
  })

  it('keeps two worktrees apart and one worktree stable', () => {
    const a = dispatchMemoryKey({ worktree: '/a', agentHandle: 'term_a' })
    const b = dispatchMemoryKey({ worktree: '/b', agentHandle: 'term_a' })
    expect(a.workspaceId).not.toBe(b.workspaceId)
    expect(dispatchMemoryKey({ worktree: '/a', agentHandle: 'term_a' }).workspaceId).toBe(
      a.workspaceId
    )
  })

  // A coordinator with no worktree selector is a supported case (§7.4), so it
  // gets a real scope rather than being refused.
  it('scopes a coordinator with no worktree instead of failing', () => {
    expect(dispatchMemoryKey({ worktree: undefined, agentHandle: 'term_a' }).workspaceId).toBe(
      UNSCOPED_AGENT_MEMORY_WORKSPACE
    )
  })
})

describe('loading memory for a dispatch', () => {
  // The path goes into the preamble for the worker to edit, and the worker runs
  // in its own worktree — a store-relative path would resolve to the wrong file.
  it('reads back what the agent recorded, with an absolute path to edit', async () => {
    const key = dispatchMemoryKey({ worktree: '/repo', agentHandle: 'term_a' })
    await replaceAgentMemory({ key, text: 'the build uses pnpm', userDataPath })
    const loaded = await loadDispatchMemory({
      worktree: '/repo',
      agentHandle: 'term_a',
      userDataPath
    })
    expect(loaded).toEqual({
      path: agentMemoryPath(key, userDataPath),
      text: 'the build uses pnpm'
    })
    expect(isAbsolute(loaded?.path ?? '')).toBe(true)
  })

  it('gives one agent nothing of another agent’s memory', async () => {
    await replaceAgentMemory({
      key: dispatchMemoryKey({ worktree: '/repo', agentHandle: 'term_a' }),
      text: 'mine',
      userDataPath
    })
    expect(
      await loadDispatchMemory({ worktree: '/repo', agentHandle: 'term_b', userDataPath })
    ).toBeNull()
  })

  // Every failure below must be absence, never a thrown error: a dispatch that
  // died over an unreadable memory file would trade the task for a paragraph.
  it('treats a first-ever dispatch as no memory', async () => {
    expect(
      await loadDispatchMemory({ worktree: '/repo', agentHandle: 'term_new', userDataPath })
    ).toBeNull()
  })

  it('treats whitespace-only memory as no memory', async () => {
    await replaceAgentMemory({
      key: dispatchMemoryKey({ worktree: '/repo', agentHandle: 'term_a' }),
      text: '   \n  ',
      userDataPath
    })
    expect(
      await loadDispatchMemory({ worktree: '/repo', agentHandle: 'term_a', userDataPath })
    ).toBeNull()
  })

  it('treats a handle it cannot turn into a path as no memory', async () => {
    expect(
      await loadDispatchMemory({ worktree: '/repo', agentHandle: '../escape', userDataPath })
    ).toBeNull()
  })
})
