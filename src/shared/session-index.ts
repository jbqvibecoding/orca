// The wire contract with the wake-index sidecar.
//
// Parsed defensively rather than cast. The sidecar is a separately built
// binary that a user can pin to an older or newer version than this Orca, so
// the shape that arrives is an input, not a guarantee — a missing field must
// surface as a clear error, never as `undefined` reaching the formatter.
//
// See docs/fusion/adr/ADR-0007-unified-session-index.md.

// Orca deliberately keeps no copy of the agent-id list. The sidecar refuses an
// unknown --agent and names the ones it knows, so a second list here would only
// drift — and would reject an agent a newer sidecar had learned to read.

export type SessionIndexRecord = {
  key: string
  id: string
  agent: string
  title: string
  projectPath: string
  projectName: string
  filePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
  sizeBytes: number
  gitBranch: string | null
  model: string | null
}

export type SessionSearchHit = {
  session: SessionIndexRecord
  seq: number
  role: string
  /** Matches are marked `[[hl]]…[[/hl]]`; rendering them is the caller's choice. */
  snippet: string
  timestamp: number | null
}

export type SessionSearchResult = {
  hits: SessionSearchHit[]
  count: number
  /** True when the query was too short for the trigram index and fell back to a scan. */
  degraded: boolean
}

export type SessionListResult = {
  sessions: SessionIndexRecord[]
  count: number
  total: number
}

export type SessionScanResult = { indexed: number; full: boolean }

export type SessionDoctorResult = {
  dbPath: string
  adapters: string[]
  indexedSessions: number
}

export class SessionIndexContractError extends Error {}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionIndexContractError(`The session index returned no ${what} object.`)
  }
  return value as Record<string, unknown>
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string') {
    throw new SessionIndexContractError(`The session index omitted the string field "${field}".`)
  }
  return value
}

function requireNumber(source: Record<string, unknown>, field: string): number {
  const value = source[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessionIndexContractError(`The session index omitted the number field "${field}".`)
  }
  return value
}

function optionalString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new SessionIndexContractError(`The session index field "${field}" was not a string.`)
  }
  return value
}

function requireBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field]
  if (typeof value !== 'boolean') {
    throw new SessionIndexContractError(`The session index omitted the boolean field "${field}".`)
  }
  return value
}

function requireArray(source: Record<string, unknown>, field: string): unknown[] {
  const value = source[field]
  if (!Array.isArray(value)) {
    throw new SessionIndexContractError(`The session index omitted the array field "${field}".`)
  }
  return value
}

export function parseSessionRecord(value: unknown): SessionIndexRecord {
  const raw = asObject(value, 'session')
  return {
    key: requireString(raw, 'key'),
    id: requireString(raw, 'id'),
    agent: requireString(raw, 'agent'),
    title: requireString(raw, 'title'),
    projectPath: requireString(raw, 'projectPath'),
    projectName: requireString(raw, 'projectName'),
    filePath: requireString(raw, 'filePath'),
    createdAt: requireNumber(raw, 'createdAt'),
    updatedAt: requireNumber(raw, 'updatedAt'),
    messageCount: requireNumber(raw, 'messageCount'),
    sizeBytes: requireNumber(raw, 'sizeBytes'),
    gitBranch: optionalString(raw, 'gitBranch'),
    model: optionalString(raw, 'model')
  }
}

export function parseSessionSearchResult(value: unknown): SessionSearchResult {
  const raw = asObject(value, 'search result')
  const hits = requireArray(raw, 'hits').map((entry) => {
    const hit = asObject(entry, 'search hit')
    const timestamp = hit.timestamp
    return {
      session: parseSessionRecord(hit.session),
      seq: requireNumber(hit, 'seq'),
      role: requireString(hit, 'role'),
      snippet: requireString(hit, 'snippet'),
      timestamp:
        timestamp === null || timestamp === undefined ? null : requireNumber(hit, 'timestamp')
    }
  })
  return { hits, count: requireNumber(raw, 'count'), degraded: requireBoolean(raw, 'degraded') }
}

export function parseSessionListResult(value: unknown): SessionListResult {
  const raw = asObject(value, 'list result')
  return {
    sessions: requireArray(raw, 'sessions').map(parseSessionRecord),
    count: requireNumber(raw, 'count'),
    total: requireNumber(raw, 'total')
  }
}

export function parseSessionScanResult(value: unknown): SessionScanResult {
  const raw = asObject(value, 'scan result')
  return { indexed: requireNumber(raw, 'indexed'), full: requireBoolean(raw, 'full') }
}

export function parseSessionDoctorResult(value: unknown): SessionDoctorResult {
  const raw = asObject(value, 'doctor result')
  return {
    dbPath: requireString(raw, 'dbPath'),
    adapters: requireArray(raw, 'adapters').map((entry) => {
      if (typeof entry !== 'string') {
        throw new SessionIndexContractError('The session index reported a non-string adapter.')
      }
      return entry
    }),
    indexedSessions: requireNumber(raw, 'indexedSessions')
  }
}
