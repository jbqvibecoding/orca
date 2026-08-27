// Runs an acceptance gate: resolve commands from the workspace, execute them on
// the host that owns it, and turn each exit code into a verdict.
//
// Execution is delegated to the injected precheck runner — in production
// runAutomationPrecheck, which already handles local and SSH targets with a
// bounded output tail and a timeout, and therefore already obeys
// docs/reference/ssh-execution-boundary.md.

import { randomUUID } from 'node:crypto'
import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { normalizeAutomationPrecheckTimeoutSeconds } from '../../shared/automation-precheck'
import {
  rollUpAcceptanceVerdict,
  type AcceptanceCheckName,
  type AcceptanceCheckResult,
  type AcceptanceEvent,
  type AcceptanceEventAttribution,
  type AcceptanceGateResult
} from '../../shared/acceptance-gate'
import { parseExecutionHostId } from '../../shared/execution-host'
import { createAcceptanceEvent } from './event-log'
import { PACKAGE_MANAGER_LOCKFILE_PATHS, resolveCheckCommand } from './gate-command-resolution'
import {
  resolveWorkspaceFileReader,
  type WorkspaceFileReader
} from '../workspace/workspace-file-reader'

export const DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS = 600

/**
 * Structurally compatible with runAutomationPrecheck, injected rather than
 * imported: that module reaches Electron through the SSH connection manager,
 * and dragging it in would make this logic untestable outside the app.
 */
export type AcceptancePrecheckRunner = (args: {
  precheck: AutomationPrecheck
  target: { type: 'local'; cwd: string } | { type: 'ssh'; cwd: string; connectionId: string }
}) => Promise<AutomationPrecheckResult>

export type AcceptanceGateRunOptions = {
  cwd: string
  hostId: string
  checks: readonly AcceptanceCheckName[]
  workspaceId?: string | null
  timeoutSeconds?: number
  emit?: (event: AcceptanceEvent) => void
  runPrecheck: AcceptancePrecheckRunner
}

function emptyResult(
  check: AcceptanceCheckName,
  verdict: AcceptanceCheckResult['verdict'],
  reason: string
): AcceptanceCheckResult {
  return {
    check,
    verdict,
    command: null,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    reason,
    stdoutTail: '',
    stderrTail: ''
  }
}

/**
 * A timeout is `failed`: the check was observed not completing. An absent exit
 * code with an error is `unverifiable`: the outcome was never observed at all,
 * which is what a dropped SSH channel looks like.
 */
export function verdictFromPrecheck(result: AutomationPrecheckResult): {
  verdict: AcceptanceCheckResult['verdict']
  reason: string | null
} {
  if (result.timedOut) {
    return { verdict: 'failed', reason: result.error ?? 'check timed out' }
  }
  if (result.exitCode === null) {
    return { verdict: 'unverifiable', reason: result.error ?? 'check produced no exit code' }
  }
  if (result.exitCode === 0) {
    return { verdict: 'passed', reason: null }
  }
  return { verdict: 'failed', reason: `exited ${result.exitCode}` }
}

async function readPresentLockfiles(
  reader: WorkspaceFileReader
): Promise<{ status: 'ready'; paths: string[] } | { status: 'unreachable'; reason: string }> {
  const paths: string[] = []
  for (const candidate of PACKAGE_MANAGER_LOCKFILE_PATHS) {
    const presence = await reader.fileExists(candidate)
    if (presence.status === 'unreachable') {
      return { status: 'unreachable', reason: presence.reason }
    }
    if (presence.status === 'present') {
      paths.push(candidate)
    }
  }
  return { status: 'ready', paths }
}

async function runOneCheck(args: {
  check: AcceptanceCheckName
  command: string
  cwd: string
  hostId: string
  timeoutSeconds: number
  runPrecheck: AcceptancePrecheckRunner
}): Promise<AcceptanceCheckResult> {
  const parsed = parseExecutionHostId(args.hostId)
  const precheck = { command: args.command, timeoutSeconds: args.timeoutSeconds }
  const result = await args.runPrecheck({
    precheck,
    target:
      parsed?.kind === 'ssh'
        ? { type: 'ssh', cwd: args.cwd, connectionId: parsed.targetId }
        : { type: 'local', cwd: args.cwd }
  })
  const { verdict, reason } = verdictFromPrecheck(result)
  return {
    check: args.check,
    verdict,
    command: args.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    reason,
    stdoutTail: result.stdout,
    stderrTail: result.stderr
  }
}

export async function runAcceptanceGate(
  options: AcceptanceGateRunOptions
): Promise<AcceptanceGateResult> {
  const startedAt = Date.now()
  const runPrecheck = options.runPrecheck
  const timeoutSeconds = normalizeAutomationPrecheckTimeoutSeconds(
    options.timeoutSeconds ?? DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS
  )
  const attribution: AcceptanceEventAttribution = {
    runId: randomUUID(),
    workspaceId: options.workspaceId ?? null,
    hostId: options.hostId
  }
  const sid = attribution.runId
  const emit = options.emit ?? (() => {})
  const started = createAcceptanceEvent({
    sid,
    kind: 'acceptance.gate.started',
    attribution,
    payload: { cwd: options.cwd, checks: [...options.checks] }
  })
  emit(started)

  const checks = await resolveAndRunChecks({
    ...options,
    timeoutSeconds,
    runPrecheck,
    onCheck: (check) =>
      emit(
        createAcceptanceEvent({
          sid,
          kind: 'acceptance.check.settled',
          attribution,
          parentEventId: started.eventId,
          payload: { ...check }
        })
      )
  })

  const result: AcceptanceGateResult = {
    cwd: options.cwd,
    hostId: options.hostId,
    verdict: rollUpAcceptanceVerdict(checks),
    checks,
    startedAt,
    completedAt: Date.now()
  }
  emit(
    createAcceptanceEvent({
      sid,
      kind: 'acceptance.gate.settled',
      attribution,
      parentEventId: started.eventId,
      payload: {
        verdict: result.verdict,
        durationMs: result.completedAt - result.startedAt,
        checks: checks.map((check) => ({ check: check.check, verdict: check.verdict }))
      }
    })
  )
  return result
}

async function resolveAndRunChecks(args: {
  cwd: string
  hostId: string
  checks: readonly AcceptanceCheckName[]
  timeoutSeconds: number
  runPrecheck: AcceptancePrecheckRunner
  onCheck: (check: AcceptanceCheckResult) => void
}): Promise<AcceptanceCheckResult[]> {
  const record = (results: AcceptanceCheckResult[], check: AcceptanceCheckResult) => {
    args.onCheck(check)
    results.push(check)
  }
  const results: AcceptanceCheckResult[] = []

  const readerResolution = resolveWorkspaceFileReader({ cwd: args.cwd, hostId: args.hostId })
  if (readerResolution.status === 'unsupported') {
    for (const check of args.checks) {
      record(results, emptyResult(check, 'unverifiable', readerResolution.reason))
    }
    return results
  }

  const manifest = await readerResolution.reader.readFile('package.json')
  if (manifest.status === 'unreachable') {
    for (const check of args.checks) {
      record(results, emptyResult(check, 'unverifiable', manifest.reason))
    }
    return results
  }

  const lockfiles = await readPresentLockfiles(readerResolution.reader)
  if (lockfiles.status === 'unreachable') {
    for (const check of args.checks) {
      record(results, emptyResult(check, 'unverifiable', lockfiles.reason))
    }
    return results
  }

  const packageJson = manifest.status === 'read' ? manifest.content : null
  for (const check of args.checks) {
    const resolution = resolveCheckCommand({
      check,
      packageJson,
      presentLockfilePaths: lockfiles.paths
    })
    if (resolution.status === 'skipped') {
      record(results, emptyResult(check, 'skipped', resolution.reason))
      continue
    }
    record(
      results,
      await runOneCheck({
        check,
        command: resolution.command,
        cwd: args.cwd,
        hostId: args.hostId,
        timeoutSeconds: args.timeoutSeconds,
        runPrecheck: args.runPrecheck
      })
    )
  }
  return results
}
