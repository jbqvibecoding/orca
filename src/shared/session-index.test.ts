import { describe, expect, it } from 'vitest'
import {
  parseSessionDoctorResult,
  parseSessionListResult,
  parseSessionScanResult,
  parseSessionSearchResult,
  SessionIndexContractError
} from './session-index'

const SESSION = {
  key: 'codex:abc',
  id: 'abc',
  agent: 'codex',
  title: 'QR login revamp',
  projectPath: '/repo',
  projectName: 'repo',
  filePath: '/repo/.codex/a.jsonl',
  createdAt: 1785662100000,
  updatedAt: 1785662121000,
  messageCount: 3,
  sizeBytes: 2401,
  gitBranch: 'feat/qr',
  model: 'gpt-5.2-codex'
}

describe('session index contract', () => {
  it('reads a search result, keeping the highlight markers intact', () => {
    const parsed = parseSessionSearchResult({
      hits: [{ session: SESSION, seq: 1, role: 'user', snippet: 'a [[hl]]b[[/hl]]', timestamp: 1 }],
      count: 1,
      degraded: false
    })
    expect(parsed.hits[0]?.snippet).toBe('a [[hl]]b[[/hl]]')
    expect(parsed.hits[0]?.session.gitBranch).toBe('feat/qr')
  })

  // A short query silently becoming a slow scan is the kind of thing a caller
  // needs told, so the flag has to survive parsing rather than default away.
  it('carries the degraded flag through', () => {
    expect(parseSessionSearchResult({ hits: [], count: 0, degraded: true }).degraded).toBe(true)
  })

  it('keeps a null branch and model as null rather than dropping the field', () => {
    const parsed = parseSessionListResult({
      sessions: [{ ...SESSION, gitBranch: null, model: null }],
      count: 1,
      total: 1
    })
    expect(parsed.sessions[0]).toMatchObject({ gitBranch: null, model: null })
  })

  it('reports a page smaller than the total', () => {
    const parsed = parseSessionListResult({ sessions: [SESSION], count: 1, total: 42 })
    expect(parsed.total).toBe(42)
  })

  it('reads scan and doctor results', () => {
    expect(parseSessionScanResult({ indexed: 3, full: true })).toEqual({ indexed: 3, full: true })
    expect(
      parseSessionDoctorResult({ dbPath: '/db', adapters: ['codex'], indexedSessions: 3 })
    ).toEqual({ dbPath: '/db', adapters: ['codex'], indexedSessions: 3 })
  })

  // The sidecar is built separately and a user can pin an older or newer one,
  // so a shape that does not match must name the field rather than let
  // `undefined` reach a formatter.
  it('names the missing field instead of yielding undefined', () => {
    const { updatedAt: _dropped, ...incomplete } = SESSION
    expect(() => parseSessionListResult({ sessions: [incomplete], count: 1, total: 1 })).toThrow(
      /updatedAt/
    )
    expect(() => parseSessionSearchResult({ hits: [], count: 0 })).toThrow(/degraded/)
    expect(() => parseSessionListResult('not an object')).toThrow(SessionIndexContractError)
  })

  it('refuses a wrong-typed optional field rather than coercing it', () => {
    expect(() =>
      parseSessionListResult({ sessions: [{ ...SESSION, gitBranch: 7 }], count: 1, total: 1 })
    ).toThrow(/gitBranch/)
  })
})
