// Append-only NDJSON record of every acceptance-gate verdict.
//
// Reuses the trace sink rather than adding a second appender: it already does
// synchronous writes, private file modes, batching and size rotation.
//
// Rotation means "append-only" is bounded (10 MB x 10 files by default). A run
// long enough to fill that loses its earliest events; the alternative is an
// unbounded file on the user's disk.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  buildAcceptanceEventLogPath,
  isAcceptanceEvent,
  type AcceptanceEvent,
  type AcceptanceEventAttribution,
  type AcceptanceEventKind
} from '../../shared/acceptance-gate'
import {
  createLocalFileSink,
  listRotatedFiles,
  type LocalFileSink
} from '../observability/local-file-sink'

const ACCEPTANCE_LOG_MAX_BYTES = 4 * 1024 * 1024
const ACCEPTANCE_LOG_MAX_FILES = 4

export type AcceptanceEventSink = (event: AcceptanceEvent) => void

export function createAcceptanceEvent(args: {
  sid: string
  kind: AcceptanceEventKind
  attribution: AcceptanceEventAttribution
  payload: Record<string, unknown>
  parentEventId?: string | null
  vendor?: string | null
  vendorSid?: string | null
}): AcceptanceEvent {
  return {
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    sid: args.sid,
    kind: args.kind,
    writerPid: process.pid,
    vendor: args.vendor ?? null,
    vendorSid: args.vendorSid ?? null,
    parentEventId: args.parentEventId ?? null,
    causalityKey: `acceptance:${args.attribution.runId}`,
    attribution: args.attribution,
    payload: args.payload
  }
}

let sink: LocalFileSink | null = null

export function getAcceptanceEventLogSink(logsDirectory: string): LocalFileSink {
  const filePath = buildAcceptanceEventLogPath(logsDirectory)
  if (sink && sink.filePath === filePath) {
    return sink
  }
  sink?.close()
  sink = createLocalFileSink({
    filePath,
    maxBytes: ACCEPTANCE_LOG_MAX_BYTES,
    maxFiles: ACCEPTANCE_LOG_MAX_FILES
  })
  return sink
}

export function closeAcceptanceEventLogSink(): void {
  sink?.close()
  sink = null
}

function parseEventLines(content: string): AcceptanceEvent[] {
  const events: AcceptanceEvent[] = []
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (isAcceptanceEvent(parsed)) {
        events.push(parsed)
      }
    } catch {
      // A torn final line from a crash mid-write is expected; skip it.
    }
  }
  return events
}

/** Newest-last, across the rotated family, capped at `limit`. */
export function readAcceptanceEvents(logsDirectory: string, limit: number): AcceptanceEvent[] {
  const filePath = buildAcceptanceEventLogPath(logsDirectory)
  sink?.flush()
  // listRotatedFiles already includes the base file, newest first.
  const files = listRotatedFiles(filePath, ACCEPTANCE_LOG_MAX_FILES)
  const collected: AcceptanceEvent[] = []
  // Oldest rotation first so the concatenated order stays chronological.
  for (const candidate of files.toReversed()) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      collected.push(...parseEventLines(readFileSync(candidate, 'utf-8')))
    } catch {
      // A rotation removed underneath us is not worth failing the read.
    }
  }
  return collected.slice(-limit)
}
