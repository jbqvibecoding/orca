// Drives the `orca sessions` handlers against the real sidecar binary.
//
// The pieces are covered elsewhere; what only this file proves is the whole
// chain — CLI flags, the argv handed to the sidecar, the JSON that comes back,
// and what a user actually reads. A flag translated wrongly is invisible to
// every test that stops at one of those seams.
//
// Skipped when the sidecar has not been built (`pnpm run build:session-index`).

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSIONS_HANDLERS } from './sessions'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { SESSION_INDEX_SIDECAR_PATH_ENV } from '../session-index-sidecar-path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const sidecarPath = join(repoRoot, 'resources', 'session-index', 'wake-index')
const wakeFixtures = resolve(repoRoot, '..', 'Wake', 'crates', 'wake-core', 'tests', 'fixtures')
const describeWithSidecar =
  existsSync(sidecarPath) && existsSync(wakeFixtures) ? describe : describe.skip

let home: string
let printed: string[]

function context(flags = new Map<string, string | boolean>(), json = false) {
  return { client: { call: vi.fn(), isRemote: false }, cwd: '/repo', flags, json } as never
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-sessions-cli-'))
  cpSync(join(wakeFixtures, 'claude'), join(home, '.claude'), { recursive: true })
  cpSync(join(wakeFixtures, 'codex'), join(home, '.codex'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv(SESSION_INDEX_SIDECAR_PATH_ENV, sidecarPath)
  printed = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.push(line)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function reindex(): Promise<void> {
  await SESSIONS_HANDLERS['sessions reindex']!(context(new Map([['full', true]])))
  printed = []
}

describeWithSidecar('orca sessions handlers end to end', () => {
  it('reports what a rescan indexed', async () => {
    await SESSIONS_HANDLERS['sessions reindex']!(context(new Map([['full', true]])))
    expect(printed.join('\n')).toMatch(/Full rescan complete: [1-9]\d* sessions indexed\./)
  })

  it('lists sessions with the project, message count and file each came from', async () => {
    await reindex()
    await SESSIONS_HANDLERS['sessions list']!(context())
    const output = printed.join('\n')
    expect(output).toContain('wakefx')
    expect(output).toContain('messages')
    expect(output).toContain('.jsonl')
  })

  // The one that would silently break: --agent is a repeated flag, and the CLI
  // packs repeats into a single map value.
  it('passes a repeated --agent through to the sidecar filter', async () => {
    await reindex()
    await SESSIONS_HANDLERS['sessions list']!(context(new Map([['agent', 'codex']])))
    expect(printed.join('\n')).not.toContain('claude-code')

    printed = []
    await SESSIONS_HANDLERS['sessions list']!(
      context(new Map([['agent', `codex${REPEATED_FLAG_SEPARATOR}claude-code`]]))
    )
    const both = printed.join('\n')
    expect(both).toContain('codex')
    expect(both).toContain('claude-code')
  })

  it('surfaces an unknown agent as an error rather than a wider result', async () => {
    await reindex()
    await expect(
      SESSIONS_HANDLERS['sessions list']!(context(new Map([['agent', 'not-an-agent']])))
    ).rejects.toThrow(/known agents/)
  })

  it('searches message text and shows the matching snippet', async () => {
    await reindex()
    await SESSIONS_HANDLERS['sessions search']!(context(new Map([['query', 'useEffect(']])))
    const output = printed.join('\n')
    expect(output).toContain('[[hl]]')
    expect(output).not.toContain('No matches')
  })

  // A short query silently becoming a slow scan is exactly the thing a user
  // should be told about, so it has to reach the rendered output.
  it('tells the user when a query was too short for the index', async () => {
    await reindex()
    await SESSIONS_HANDLERS['sessions search']!(context(new Map([['query', 'zz']])))
    expect(printed.join('\n')).toContain('too short for the index')
  })

  it('honours --limit', async () => {
    await reindex()
    await SESSIONS_HANDLERS['sessions list']!(context(new Map([['limit', '1']]), true))
    const payload = JSON.parse(printed.join('\n'))
    expect(payload.result.count).toBe(1)
    expect(payload.result.total).toBeGreaterThan(1)
  })

  it('names the sidecar and the index in doctor output', async () => {
    await SESSIONS_HANDLERS['sessions doctor']!(context())
    const output = printed.join('\n')
    expect(output).toContain(sidecarPath)
    expect(output).toContain(home)
    expect(output).toContain('codex')
  })
})

describeWithSidecar('orca sessions sidecar selection', () => {
  // The env var is tried first, not exclusively: a path that does not exist
  // falls through to the install copy rather than failing. Proving it here is
  // what keeps the "not found" message from overclaiming.
  it('falls through to the install copy when the pinned path does not exist', async () => {
    vi.stubEnv(SESSION_INDEX_SIDECAR_PATH_ENV, join(tmpdir(), 'orca-no-such-sidecar'))
    await SESSIONS_HANDLERS['sessions doctor']!(context())
    expect(printed.join('\n')).toContain(sidecarPath)
  })
})
