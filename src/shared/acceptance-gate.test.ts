import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_CHECK_NAMES,
  isAcceptanceCheckName,
  rollUpAcceptanceVerdict,
  summarizeAcceptanceCheck,
  type AcceptanceCheckResult
} from './acceptance-gate'
import { buildOrchestrationEventLogPath, isOrchestrationEvent } from './orchestration-event'

function verdicts(...values: AcceptanceCheckResult['verdict'][]) {
  return values.map((verdict) => ({ verdict }))
}

describe('acceptance check names', () => {
  it('only admits the three executable checks', () => {
    expect([...ACCEPTANCE_CHECK_NAMES]).toEqual(['typecheck', 'test', 'lint'])
    expect(isAcceptanceCheckName('test')).toBe(true)
    expect(isAcceptanceCheckName('build')).toBe(false)
    expect(isAcceptanceCheckName('rm -rf /')).toBe(false)
    expect(isAcceptanceCheckName(undefined)).toBe(false)
  })
})

describe('rollUpAcceptanceVerdict', () => {
  it('reports failed when any check failed', () => {
    expect(rollUpAcceptanceVerdict(verdicts('passed', 'failed', 'skipped'))).toBe('failed')
  })

  it('prefers failed over unverifiable', () => {
    expect(rollUpAcceptanceVerdict(verdicts('unverifiable', 'failed'))).toBe('failed')
  })

  it('reports unverifiable when nothing failed but something could not be observed', () => {
    expect(rollUpAcceptanceVerdict(verdicts('passed', 'unverifiable'))).toBe('unverifiable')
  })

  it('passes when at least one check passed and none failed or went unobserved', () => {
    expect(rollUpAcceptanceVerdict(verdicts('passed', 'skipped'))).toBe('passed')
  })

  // The load-bearing case: a project with no scripts must never read as a pass.
  it('stays skipped when every check was skipped', () => {
    expect(rollUpAcceptanceVerdict(verdicts('skipped', 'skipped'))).toBe('skipped')
  })

  it('stays skipped when there are no checks at all', () => {
    expect(rollUpAcceptanceVerdict([])).toBe('skipped')
  })
})

describe('buildOrchestrationEventLogPath', () => {
  it('places the log inside the given logs directory', () => {
    expect(buildOrchestrationEventLogPath('/logs')).toMatch(/acceptance-events\.ndjson$/)
    expect(buildOrchestrationEventLogPath('/logs')).toContain('logs')
  })
})

describe('isOrchestrationEvent', () => {
  const valid = {
    eventId: 'e1',
    ts: '2026-01-01T00:00:00.000Z',
    sid: 's1',
    kind: 'acceptance.gate.settled',
    writerPid: 1,
    vendor: null,
    vendorSid: null,
    parentEventId: null,
    causalityKey: 'acceptance:r1',
    attribution: { runId: 'r1', workspaceId: null, hostId: 'local' },
    payload: {}
  }

  it('accepts a well-formed event', () => {
    expect(isOrchestrationEvent(valid)).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(isOrchestrationEvent({ ...valid, kind: 'something.else' })).toBe(false)
  })

  it('rejects an event with no attribution', () => {
    expect(isOrchestrationEvent({ ...valid, attribution: null })).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isOrchestrationEvent('nope')).toBe(false)
    expect(isOrchestrationEvent(null)).toBe(false)
  })
})

describe('summarizeAcceptanceCheck', () => {
  it('names the command and the reason when present', () => {
    const summary = summarizeAcceptanceCheck({
      check: 'test',
      verdict: 'failed',
      command: 'pnpm run test',
      exitCode: 1,
      timedOut: false,
      durationMs: 12,
      reason: 'exited 1',
      stdoutTail: '',
      stderrTail: ''
    })
    expect(summary).toBe('test: failed (pnpm run test) — exited 1')
  })

  it('omits both when a check never ran', () => {
    const summary = summarizeAcceptanceCheck({
      check: 'lint',
      verdict: 'skipped',
      command: null,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      reason: null,
      stdoutTail: '',
      stderrTail: ''
    })
    expect(summary).toBe('lint: skipped')
  })
})
