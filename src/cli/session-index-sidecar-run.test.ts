// Runs the real sidecar binary against real agent-session fixtures.
//
// The point is the wire format. Every other test here parses JSON this repo
// wrote, which proves only that the parser agrees with itself; the shape that
// actually arrives comes from a separately built Rust binary, and a field
// renamed there would pass every hand-written fixture and fail in the product.
//
// Skipped when the sidecar has not been built (`pnpm run build:session-index`),
// because a missing optional artifact is not a test failure.

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseSessionIndexJson,
  runSessionIndexSidecar,
  SessionIndexOutputError
} from './session-index-sidecar-run'
import {
  parseSessionDoctorResult,
  parseSessionListResult,
  parseSessionScanResult,
  parseSessionSearchResult
} from '../shared/session-index'

const repoRoot = resolve(__dirname, '..', '..')
const sidecarPath = join(repoRoot, 'resources', 'session-index', 'wake-index')
// Wake's own adapter fixtures: real transcripts in each tool's on-disk layout.
const wakeFixtures = resolve(repoRoot, '..', 'Wake', 'crates', 'wake-core', 'tests', 'fixtures')
const available = existsSync(sidecarPath) && existsSync(wakeFixtures)

const describeWithSidecar = available ? describe : describe.skip

let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-session-index-'))
  cpSync(join(wakeFixtures, 'claude'), join(home, '.claude'), { recursive: true })
  cpSync(join(wakeFixtures, 'codex'), join(home, '.codex'), { recursive: true })
  previousHome = process.env.HOME
  // The runner passes no env, so the child inherits this one at spawn time.
  process.env.HOME = home
})
afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = previousHome
  }
  rmSync(home, { recursive: true, force: true })
})

async function run(argv: readonly string[]): Promise<unknown> {
  const outcome = await runSessionIndexSidecar({ sidecarPath, argv, timeoutMs: 120_000 })
  if (outcome.status === 'failed') {
    throw new Error(`sidecar failed: ${outcome.message}`)
  }
  return parseSessionIndexJson(outcome.stdout)
}

describeWithSidecar('session index sidecar against real fixtures', () => {
  it('indexes sessions from more than one tool', async () => {
    const scan = parseSessionScanResult(await run(['scan', '--full']))
    expect(scan).toMatchObject({ full: true })
    expect(scan.indexed).toBeGreaterThan(0)

    const list = parseSessionListResult(await run(['list', '--limit', '10']))
    const agents = new Set(list.sessions.map((session) => session.agent))
    expect(agents.size).toBeGreaterThan(1)
  })

  // The whole reason for a trigram index: `useEffect(` is a substring inside a
  // word, and a word-tokenised search cannot find it.
  it('finds a code substring, not just whole words', async () => {
    await run(['scan', '--full'])
    const found = parseSessionSearchResult(await run(['search', '--query', 'useEffect(']))
    expect(found.count).toBeGreaterThan(0)
    expect(found.hits[0]?.snippet).toContain('[[hl]]')
    expect(found.degraded).toBe(false)
  })

  // CJK has no spaces, so the same tokenisation problem is the normal case.
  it('finds CJK text', async () => {
    await run(['scan', '--full'])
    const found = parseSessionSearchResult(await run(['search', '--query', '扫码登录']))
    expect(found.count).toBeGreaterThan(0)
  })

  it('reports a query too short for the index as degraded rather than pretending', async () => {
    await run(['scan', '--full'])
    expect(parseSessionSearchResult(await run(['search', '--query', 'ab'])).degraded).toBe(true)
  })

  it('filters to one agent', async () => {
    await run(['scan', '--full'])
    const list = parseSessionListResult(await run(['list', '--agent', 'codex']))
    expect(list.sessions.length).toBeGreaterThan(0)
    expect(list.sessions.every((session) => session.agent === 'codex')).toBe(true)
  })

  it('names the agents it can read and where the index lives', async () => {
    const doctor = parseSessionDoctorResult(await run(['doctor']))
    expect(doctor.adapters).toContain('codex')
    expect(doctor.dbPath.startsWith(home)).toBe(true)
  })

  // An unknown filter that were silently dropped would return a result set
  // wider than the caller asked for, with no way to tell.
  it('refuses an unknown agent instead of widening the result', async () => {
    const outcome = await runSessionIndexSidecar({
      sidecarPath,
      argv: ['list', '--agent', 'not-an-agent']
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' && outcome.message).toContain('known agents')
  })

  // stdout carries valid JSON or nothing; diagnostics go to stderr. That is what
  // lets the caller parse stdout unconditionally.
  it('keeps diagnostics off stdout', async () => {
    const outcome = await runSessionIndexSidecar({ sidecarPath, argv: ['list'] })
    expect(outcome.status).toBe('ok')
    expect(() => parseSessionIndexJson(outcome.status === 'ok' ? outcome.stdout : '')).not.toThrow()
  })
})

describe('session index output handling', () => {
  it('treats non-JSON output as a fault rather than an empty result', () => {
    expect(() => parseSessionIndexJson('wake-index: usage...')).toThrow(SessionIndexOutputError)
    expect(() => parseSessionIndexJson('   ')).toThrow(/no output/)
  })

  it('reports a missing binary as a failed run, not a thrown error', async () => {
    const outcome = await runSessionIndexSidecar({
      sidecarPath: join(tmpdir(), 'orca-no-such-session-index'),
      argv: ['doctor']
    })
    expect(outcome.status).toBe('failed')
  })
})
