import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import {
  isAcceptanceCheckName,
  summarizeAcceptanceCheck,
  type AcceptanceCheckName,
  type AcceptanceEvent,
  type AcceptanceGateResult
} from '../../shared/acceptance-gate'

/**
 * A valueless `--flag` parses as `true`, which the optional-string readers then
 * treat as absent. For --check that would silently widen the run to all three
 * checks after the caller asked to narrow it, so refuse instead.
 */
function rejectValuelessFlag(
  flags: Map<string, string | boolean>,
  name: string,
  hint: string
): void {
  if (flags.get(name) === true) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a value: ${hint}`)
  }
}

function parseChecks(flags: Map<string, string | boolean>): AcceptanceCheckName[] | undefined {
  rejectValuelessFlag(flags, 'check', 'typecheck, test, or lint.')
  const raw = getRepeatedStringFlag(flags, 'check')
  if (raw.length === 0) {
    return undefined
  }
  const invalid = raw.filter((entry) => !isAcceptanceCheckName(entry))
  if (invalid.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --check value(s): ${invalid.join(', ')}. Allowed: typecheck, test, lint.`
    )
  }
  return raw.filter(isAcceptanceCheckName)
}

function formatGate(value: { gate: AcceptanceGateResult }): string {
  const { gate } = value
  const lines = [
    `${gate.verdict.toUpperCase()} — ${gate.cwd} on ${gate.hostId} (${gate.completedAt - gate.startedAt}ms)`,
    ...gate.checks.map((check) => `  ${summarizeAcceptanceCheck(check)}`)
  ]
  const failing = gate.checks.find((check) => check.verdict === 'failed' && check.stderrTail)
  if (failing) {
    lines.push('', `--- ${failing.check} stderr (tail) ---`, failing.stderrTail.trimEnd())
  }
  return lines.join('\n')
}

function formatEvents(value: { events: AcceptanceEvent[]; count: number }): string {
  if (value.count === 0) {
    return 'No acceptance-gate events recorded yet.'
  }
  return value.events
    .map(
      (event) =>
        `${event.ts} ${event.kind} run=${event.attribution.runId} ${JSON.stringify(event.payload)}`
    )
    .join('\n')
}

export const ACCEPTANCE_HANDLERS: Record<string, CommandHandler> = {
  'acceptance run': async ({ flags, client, cwd, json }) => {
    rejectValuelessFlag(flags, 'cwd', 'a workspace directory.')
    rejectValuelessFlag(flags, 'host', 'local or ssh:<target>.')
    const result = await client.call<{ gate: AcceptanceGateResult }>('acceptance.run', {
      cwd: resolve(getOptionalStringFlag(flags, 'cwd') ?? cwd),
      hostId: getOptionalStringFlag(flags, 'host'),
      checks: parseChecks(flags),
      timeoutSeconds: getOptionalPositiveIntegerFlag(flags, 'timeout-seconds')
    })
    printResult(result, json, formatGate)
  },
  'acceptance log': async ({ flags, client, json }) => {
    const result = await client.call<{ events: AcceptanceEvent[]; count: number }>(
      'acceptance.log',
      { limit: getOptionalPositiveIntegerFlag(flags, 'limit') }
    )
    printResult(result, json, formatEvents)
  }
}
