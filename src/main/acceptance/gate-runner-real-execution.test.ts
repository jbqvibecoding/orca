// Runs the gate through the real precheck runner against real npm scripts.
//
// The injected-runner tests prove the wiring; this one proves the thing the
// wiring depends on: that a real exit code becomes the right verdict. A mock
// that returns `exitCode: 0` cannot tell us the command ever ran.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAutomationPrecheck } from '../automations/precheck-runner'
import { runAcceptanceGate } from './gate-runner'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-acceptance-real-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeManifest(scripts: Record<string, string>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', scripts }), 'utf-8')
}

describe('acceptance gate over real command execution', () => {
  it('maps real exit codes to verdicts, and a missing script to skipped', async () => {
    writeManifest({ test: 'exit 0', typecheck: 'exit 3' })
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test', 'typecheck', 'lint'],
      runPrecheck: runAutomationPrecheck
    })

    const byCheck = new Map(result.checks.map((check) => [check.check, check]))
    expect(byCheck.get('test')).toMatchObject({ verdict: 'passed', exitCode: 0 })
    expect(byCheck.get('typecheck')).toMatchObject({ verdict: 'failed', exitCode: 3 })
    expect(byCheck.get('lint')).toMatchObject({ verdict: 'skipped', command: null })
    expect(result.verdict).toBe('failed')
  }, 60_000)

  it('reports a command that outruns its budget as failed, not unverifiable', async () => {
    writeManifest({ test: 'sleep 30' })
    const result = await runAcceptanceGate({
      cwd: dir,
      hostId: 'local',
      checks: ['test'],
      timeoutSeconds: 1,
      runPrecheck: runAutomationPrecheck
    })
    expect(result.checks[0]).toMatchObject({ verdict: 'failed', timedOut: true })
    expect(result.verdict).toBe('failed')
  }, 60_000)
})
