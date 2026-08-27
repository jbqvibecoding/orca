import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentMemoryPath,
  agentMemoryRelativePath,
  appendAgentMemory,
  readAgentMemory,
  replaceAgentMemory
} from './memory-store'

const KEY = { workspaceId: 'wt1', agentHandle: 'term_abc123' }

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-memory-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('agent memory store', () => {
  // Absent memory is the normal state on an agent's first turn, not an error.
  it('reads an agent with no memory yet as empty', async () => {
    expect(await readAgentMemory(KEY, userDataPath)).toEqual({ text: '', exists: false })
  })

  it('writes and reads memory back', async () => {
    await replaceAgentMemory({ key: KEY, text: 'the build uses pnpm', userDataPath })
    expect(await readAgentMemory(KEY, userDataPath)).toEqual({
      text: 'the build uses pnpm',
      exists: true
    })
  })

  it('appends onto a newline boundary', async () => {
    await replaceAgentMemory({ key: KEY, text: 'first', userDataPath })
    await appendAgentMemory({ key: KEY, entry: 'second', userDataPath })
    expect((await readAgentMemory(KEY, userDataPath)).text).toBe('first\nsecond')
  })

  // Memory holds whatever the agent wrote, including a key it pasted without
  // thinking — and once written it is in the audit history too.
  it('redacts secrets on the way in, not on the way out', async () => {
    const write = await replaceAgentMemory({
      key: KEY,
      text: 'token: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      userDataPath
    })
    expect(write.redacted).toBe(true)
    const onDisk = readFileSync(agentMemoryPath(KEY, userDataPath), 'utf-8')
    expect(onDisk).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('bounds memory and reports the trim', async () => {
    const write = await replaceAgentMemory({
      key: KEY,
      text: `${'old '.repeat(200)}NEWEST`,
      userDataPath,
      maxBytes: 64
    })
    expect(write.trimmed).toBe(true)
    expect(write.droppedBytes).toBeGreaterThan(0)
    expect((await readAgentMemory(KEY, userDataPath)).text.endsWith('NEWEST')).toBe(true)
  })

  // A crash mid-write must not leave memory the agent reads back as fact.
  it('leaves no staging file behind after a write', async () => {
    await replaceAgentMemory({ key: KEY, text: 'settled', userDataPath })
    const dir = join(userDataPath, 'agent-memory', KEY.workspaceId, KEY.agentHandle)
    expect(readdirSync(dir)).toEqual(['memory.md'])
  })

  it('gives the same relative path on disk and in the audit repo', () => {
    expect(agentMemoryRelativePath(KEY)).toBe('wt1/term_abc123/memory.md')
    expect(agentMemoryPath(KEY, userDataPath)).toBe(
      join(userDataPath, 'agent-memory', 'wt1', 'term_abc123', 'memory.md')
    )
  })

  it('refuses a key that could escape the memory directory', () => {
    expect(() => agentMemoryRelativePath({ workspaceId: '../..', agentHandle: 'term_a' })).toThrow(
      /workspaceId/
    )
  })

  it('keeps two agents in separate files', async () => {
    await replaceAgentMemory({ key: KEY, text: 'mine', userDataPath })
    const other = { workspaceId: 'wt1', agentHandle: 'term_other' }
    await replaceAgentMemory({ key: other, text: 'theirs', userDataPath })
    expect((await readAgentMemory(KEY, userDataPath)).text).toBe('mine')
    expect((await readAgentMemory(other, userDataPath)).text).toBe('theirs')
  })
})
