import { describe, expect, it } from 'vitest'
import {
  checkAgentMemoryKey,
  isValidAgentMemorySegment,
  MAX_AGENT_MEMORY_BYTES,
  trimAgentMemory
} from './agent-memory'

describe('agent memory keys', () => {
  it('accepts the ids Orca actually generates', () => {
    expect(isValidAgentMemorySegment('term_abc123')).toBe(true)
    expect(isValidAgentMemorySegment('repo::path-to-worktree')).toBe(false)
    expect(checkAgentMemoryKey({ workspaceId: 'wt1', agentHandle: 'term_a' })).toEqual({ ok: true })
  })

  // The segments are joined onto a real directory, so traversal is refused
  // rather than sanitised: rewriting it could land one agent's memory in another's file.
  it('refuses anything that could escape the memory directory', () => {
    for (const bad of ['..', '.', '../etc', 'a/b', '', '/abs', 'a\\b']) {
      expect(isValidAgentMemorySegment(bad), bad).toBe(false)
    }
  })

  it('names which field was wrong', () => {
    const checked = checkAgentMemoryKey({ workspaceId: '../escape', agentHandle: 'term_a' })
    expect(checked).toMatchObject({ ok: false, field: 'workspaceId' })
    expect(checked.ok === false && checked.reason).toContain('../escape')
  })
})

describe('trimAgentMemory', () => {
  it('leaves memory inside the budget untouched', () => {
    const trim = trimAgentMemory('short memory')
    expect(trim).toEqual({ text: 'short memory', trimmed: false, droppedBytes: 0 })
  })

  // Newest entries are the ones still worth having; the drop is reported, not silent.
  it('keeps the tail and reports what it dropped', () => {
    const text = `${'old '.repeat(100)}NEWEST`
    const trim = trimAgentMemory(text, 32)
    expect(trim.trimmed).toBe(true)
    expect(trim.text.endsWith('NEWEST')).toBe(true)
    expect(trim.droppedBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(trim.text, 'utf-8')).toBeLessThanOrEqual(32)
  })

  // A tail cut at a byte offset could split a multi-byte character in half.
  it('does not split a multi-byte character', () => {
    const trim = trimAgentMemory('日本語のメモリ'.repeat(20), 40)
    expect(trim.text).not.toContain('�')
    expect(Buffer.byteLength(trim.text, 'utf-8')).toBeLessThanOrEqual(40)
  })

  it('bounds memory so context cannot grow without limit', () => {
    const trim = trimAgentMemory('x'.repeat(MAX_AGENT_MEMORY_BYTES * 2))
    expect(Buffer.byteLength(trim.text, 'utf-8')).toBeLessThanOrEqual(MAX_AGENT_MEMORY_BYTES)
  })
})
