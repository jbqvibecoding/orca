import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { AcceptanceEvent } from '../../shared/acceptance-gate'
import {
  runAcceptanceGate,
  verdictFromPrecheck,
  type AcceptancePrecheckRunner
} from './gate-runner'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-acceptance-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function precheckResult(overrides: Partial<AutomationPrecheckResult>): AutomationPrecheckResult {
  return {
    command: 'npm run test',
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    startedAt: 0,
    completedAt: 5,
    ...overrides
  }
}

function runnerReturning(result: Partial<AutomationPrecheckResult>): AcceptancePrecheckRunner {
  return async () => precheckResult(result)
}

function writeManifest(scripts: Record<string, string>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }), 'utf-8')
}

describe('verdictFromPrecheck', () => {
  it('passes on exit 0', () => {
    expect(verdictFromPrecheck(precheckResult({ exitCode: 0 }))).toEqual({
      verdict: 'passed',
      reason: null
    })
  })

  it('fails on a non-zero exit', () => {
    expect(verdictFromPrecheck(precheckResult({ exitCode: 2 }))).toMatchObject({
      verdict: 'failed',
      reason: 'exited 2'
    })
  })

  // Observed not completing is a failure; never observed at all is not.
  it('fails on timeout', () => {
    expect(
      verdictFromPrecheck(precheckResult({ exitCode: null, timedOut: true, error: 'timed out' }))
    ).toMatchObject({ verdict: 'failed' })
  })

  it('is unverifiable when no exit code was ever observed', () => {
    expect(
      verdictFromPrecheck(precheckResult({ exitCode: null, error: 'SSH target is not connected.' }))
    ).toEqual({ verdict: 'unverifiable', reason: 'SSH target is not connected.' })
  })
})

describe('runAcceptanceGate', () => {
  it('passes when the resolved command exits zero', async () => {
    writeManifest({ test: 'vitest run' })
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test'],
      runPrecheck: runnerReturning({ exitCode: 0 })
    })
    expect(result.verdict).toBe('passed')
    expect(result.checks[0]).toMatchObject({ command: 'npm run test', verdict: 'passed' })
  })

  it('fails when the command exits non-zero', async () => {
    writeManifest({ test: 'vitest run' })
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test'],
      runPrecheck: runnerReturning({ exitCode: 1, stderr: 'boom' })
    })
    expect(result.verdict).toBe('failed')
    expect(result.checks[0].stderrTail).toBe('boom')
  })

  it('skips a check the workspace has no script for, and does not call the runner', async () => {
    writeManifest({ test: 'vitest run' })
    let calls = 0
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['lint'],
      runPrecheck: async () => {
        calls += 1
        return precheckResult({})
      }
    })
    expect(calls).toBe(0)
    expect(result.verdict).toBe('skipped')
    expect(result.checks[0].reason).toContain('no "lint" script')
  })

  it('reports skipped — never passed — when the workspace has no package.json', async () => {
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['typecheck', 'test', 'lint'],
      runPrecheck: runnerReturning({ exitCode: 0 })
    })
    expect(result.verdict).toBe('skipped')
    expect(result.checks).toHaveLength(3)
  })

  it('is unverifiable against a runtime host it cannot read', async () => {
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'runtime:some-env',
      checks: ['test'],
      runPrecheck: runnerReturning({ exitCode: 0 })
    })
    expect(result.verdict).toBe('unverifiable')
    expect(result.checks[0].reason).toContain('runtime:some-env')
  })

  it('is unverifiable, not failed, when the SSH host is not connected', async () => {
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'ssh:build-box',
      checks: ['test'],
      runPrecheck: runnerReturning({ exitCode: 0 })
    })
    expect(result.verdict).toBe('unverifiable')
    expect(result.checks[0].reason).toContain('not connected')
  })

  it('runs each requested check and rolls the worst verdict up', async () => {
    writeManifest({ typecheck: 'tsc', test: 'vitest run' })
    const exits = new Map([
      ['npm run typecheck', 0],
      ['npm run test', 1]
    ])
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['typecheck', 'test', 'lint'],
      runPrecheck: async ({ precheck }) =>
        precheckResult({ exitCode: exits.get(precheck.command) ?? 0 })
    })
    expect(result.checks.map((check) => check.verdict)).toEqual(['passed', 'failed', 'skipped'])
    expect(result.verdict).toBe('failed')
  })

  it('emits started, per-check and settled events, all carrying attribution', async () => {
    writeManifest({ test: 'vitest run' })
    const events: AcceptanceEvent[] = []
    await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test'],
      workspaceId: 'ws-1',
      runPrecheck: runnerReturning({ exitCode: 0 }),
      emit: (event) => events.push(event)
    })
    expect(events.map((event) => event.kind)).toEqual([
      'acceptance.gate.started',
      'acceptance.check.settled',
      'acceptance.gate.settled'
    ])
    const runIds = new Set(events.map((event) => event.attribution.runId))
    expect(runIds.size).toBe(1)
    for (const event of events) {
      expect(event.attribution).toMatchObject({ workspaceId: 'ws-1', hostId: 'local' })
      expect(event.eventId).toBeTruthy()
      expect(event.writerPid).toBe(process.pid)
    }
    expect(events[1].parentEventId).toBe(events[0].eventId)
  })

  it('uses the pnpm lockfile to build the command', async () => {
    writeManifest({ test: 'vitest run' })
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf-8')
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test'],
      runPrecheck: runnerReturning({ exitCode: 0 })
    })
    expect(result.checks[0].command).toBe('pnpm run test')
  })
})
