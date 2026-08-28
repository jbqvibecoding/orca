// Acceptance gates: mechanical verdicts nobody is asked for.
//
// Distinct from Orca's *decision* gates (`orca orchestration gate-*`), which
// block on a human answer. An acceptance gate decides from an exit code and a
// script's existence, so an agent's claim that the work is done can be
// contradicted from outside its own session.
//
// See docs/fusion/adr/ADR-0005-acceptance-gates-and-event-log.md.

/**
 * The only commands an acceptance gate may run.
 *
 * The point of the list is that it cannot grow at runtime: a gate that runs an
 * arbitrary command is a gate the agent under test can write, and therefore
 * pass. Widening this needs a new ADR, not a config flag.
 */
export const ACCEPTANCE_CHECK_NAMES = ['typecheck', 'test', 'lint'] as const
export type AcceptanceCheckName = (typeof ACCEPTANCE_CHECK_NAMES)[number]

export function isAcceptanceCheckName(value: unknown): value is AcceptanceCheckName {
  return typeof value === 'string' && (ACCEPTANCE_CHECK_NAMES as readonly string[]).includes(value)
}

/**
 * `unverifiable` is not a synonym for `failed`: it means the execution host
 * could not be reached, and loss of contact is never evidence that a check
 * failed. See docs/reference/ssh-execution-boundary.md.
 */
export type AcceptanceVerdict = 'passed' | 'failed' | 'unverifiable' | 'skipped'

export type AcceptanceCheckResult = {
  check: AcceptanceCheckName
  verdict: AcceptanceVerdict
  /** Resolved command, or null when nothing ran. */
  command: string | null
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** One sentence explaining any verdict other than `passed`. */
  reason: string | null
  stdoutTail: string
  stderrTail: string
}

export type AcceptanceGateResult = {
  cwd: string
  hostId: string
  verdict: AcceptanceVerdict
  checks: AcceptanceCheckResult[]
  startedAt: number
  completedAt: number
}

/**
 * Rolls per-check verdicts into one.
 *
 * All-skipped stays `skipped` rather than collapsing to `passed` — a project
 * with no scripts has no gate, and reporting that as a pass is the exact
 * false assurance this feature exists to remove.
 */
export function rollUpAcceptanceVerdict(
  checks: readonly Pick<AcceptanceCheckResult, 'verdict'>[]
): AcceptanceVerdict {
  if (checks.length === 0) {
    return 'skipped'
  }
  if (checks.some((check) => check.verdict === 'failed')) {
    return 'failed'
  }
  if (checks.some((check) => check.verdict === 'unverifiable')) {
    return 'unverifiable'
  }
  return checks.some((check) => check.verdict === 'passed') ? 'passed' : 'skipped'
}

export function summarizeAcceptanceCheck(check: AcceptanceCheckResult): string {
  const detail = check.command ? ` (${check.command})` : ''
  const reason = check.reason ? ` — ${check.reason}` : ''
  return `${check.check}: ${check.verdict}${detail}${reason}`
}
