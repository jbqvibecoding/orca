import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeRpcSuccess } from '../runtime-client'
import {
  describeMissingSessionIndex,
  resolveSessionIndexSidecar
} from '../session-index-sidecar-path'
import {
  parseSessionIndexJson,
  runSessionIndexSidecar,
  SESSION_INDEX_SCAN_TIMEOUT_MS,
  SessionIndexOutputError
} from '../session-index-sidecar-run'
import {
  parseSessionDoctorResult,
  parseSessionListResult,
  parseSessionScanResult,
  parseSessionSearchResult,
  SessionIndexContractError,
  type SessionIndexRecord,
  type SessionListResult,
  type SessionSearchResult
} from '../../shared/session-index'

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}

function requireSidecar(): string {
  const resolution = resolveSessionIndexSidecar()
  if (resolution.status === 'missing') {
    throw new RuntimeClientError('runtime_error', describeMissingSessionIndex(resolution.searched))
  }
  return resolution.path
}

async function query(argv: readonly string[], timeoutMs?: number): Promise<unknown> {
  const outcome = await runSessionIndexSidecar({
    sidecarPath: requireSidecar(),
    argv,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })
  if (outcome.status === 'failed') {
    throw new RuntimeClientError('runtime_error', outcome.message)
  }
  try {
    return parseSessionIndexJson(outcome.stdout)
  } catch (error) {
    if (error instanceof SessionIndexOutputError || error instanceof SessionIndexContractError) {
      throw new RuntimeClientError('runtime_error', error.message)
    }
    throw error
  }
}

function repeatedFlag(flags: Map<string, string | boolean>, name: string, argv: string[]): void {
  for (const value of getRepeatedStringFlag(flags, name)) {
    argv.push(`--${name}`, value)
  }
}

function optionalFlag(flags: Map<string, string | boolean>, name: string, argv: string[]): void {
  const value = getOptionalStringFlag(flags, name)
  if (value !== undefined) {
    argv.push(`--${name}`, value)
  }
}

function describeAge(updatedAtMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - updatedAtMs) / 60_000))
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function formatSession(session: SessionIndexRecord, nowMs: number): string {
  const branch = session.gitBranch ? ` (${session.gitBranch})` : ''
  return [
    `${session.agent}  ${session.title}`,
    `  ${session.projectName}${branch} · ${session.messageCount} messages · ${describeAge(session.updatedAt, nowMs)}`,
    `  ${session.filePath}`
  ].join('\n')
}

function formatSearch(value: SessionSearchResult): string {
  if (value.hits.length === 0) {
    return value.degraded
      ? 'No matches. The query was too short for the index, so this was a slower scan — try three or more characters.'
      : 'No matches.'
  }
  const now = Date.now()
  const lines = value.hits.map(
    (hit) => `${formatSession(hit.session, now)}\n  ${hit.role}: ${hit.snippet}`
  )
  if (value.degraded) {
    lines.push('', 'Note: the query was too short for the index, so this was a slower scan.')
  }
  return lines.join('\n\n')
}

function formatList(value: SessionListResult): string {
  if (value.sessions.length === 0) {
    return 'No indexed sessions. Run `orca sessions reindex` to scan this machine.'
  }
  const now = Date.now()
  const shown = value.sessions.map((session) => formatSession(session, now)).join('\n\n')
  return value.count < value.total ? `${shown}\n\nShowing ${value.count} of ${value.total}.` : shown
}

export const SESSIONS_HANDLERS: Record<string, CommandHandler> = {
  'sessions search': async ({ flags, json }) => {
    const argv = ['search', '--query', getRequiredStringFlag(flags, 'query')]
    repeatedFlag(flags, 'agent', argv)
    optionalFlag(flags, 'project', argv)
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined) {
      argv.push('--limit', String(limit))
    }
    printResult(localSuccess(parseSessionSearchResult(await query(argv))), json, formatSearch)
  },

  'sessions list': async ({ flags, json }) => {
    const argv = ['list']
    repeatedFlag(flags, 'agent', argv)
    optionalFlag(flags, 'project', argv)
    optionalFlag(flags, 'title', argv)
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined) {
      argv.push('--limit', String(limit))
    }
    const offset = getOptionalNonNegativeIntegerFlag(flags, 'offset')
    if (offset !== undefined) {
      argv.push('--offset', String(offset))
    }
    printResult(localSuccess(parseSessionListResult(await query(argv))), json, formatList)
  },

  'sessions reindex': async ({ flags, json }) => {
    const argv = flags.get('full') === true ? ['scan', '--full'] : ['scan']
    const result = parseSessionScanResult(await query(argv, SESSION_INDEX_SCAN_TIMEOUT_MS))
    printResult(
      localSuccess(result),
      json,
      (value) =>
        `${value.full ? 'Full rescan' : 'Rescan'} complete: ${value.indexed} sessions indexed.`
    )
  },

  'sessions doctor': async ({ json }) => {
    const sidecarPath = requireSidecar()
    const report = parseSessionDoctorResult(await query(['doctor']))
    printResult(localSuccess({ sidecarPath, ...report }), json, (value) =>
      [
        `Sidecar: ${value.sidecarPath}`,
        `Index:   ${value.dbPath}`,
        `Indexed: ${value.indexedSessions} sessions`,
        `Agents:  ${value.adapters.join(', ')}`
      ].join('\n')
    )
  }
}
