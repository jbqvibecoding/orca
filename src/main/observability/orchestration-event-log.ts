// Append-only NDJSON record of orchestration events: acceptance-gate verdicts
// and budget exhaustion.
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
  buildOrchestrationEventLogPath,
  isOrchestrationEvent,
  type OrchestrationEvent,
  type OrchestrationEventAttribution,
  type OrchestrationEventKind
} from '../../shared/orchestration-event'
import {
  createLocalFileSink,
  listRotatedFiles,
  type LocalFileSink
} from '../observability/local-file-sink'

const EVENT_LOG_MAX_BYTES = 4 * 1024 * 1024
const EVENT_LOG_MAX_FILES = 4

export type OrchestrationEventSink = (event: OrchestrationEvent) => void

export function createOrchestrationEvent(args: {
  sid: string
  kind: OrchestrationEventKind
  attribution: OrchestrationEventAttribution
  payload: Record<string, unknown>
  parentEventId?: string | null
  vendor?: string | null
  vendorSid?: string | null
}): OrchestrationEvent {
  return {
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    sid: args.sid,
    kind: args.kind,
    writerPid: process.pid,
    vendor: args.vendor ?? null,
    vendorSid: args.vendorSid ?? null,
    parentEventId: args.parentEventId ?? null,
    // Keyed by the event's own family so events from different writers on one
    // run stay separable; it was `acceptance:` when gates were the only writer.
    causalityKey: `${args.kind.split('.')[0]}:${args.attribution.runId}`,
    attribution: args.attribution,
    payload: args.payload
  }
}

let sink: LocalFileSink | null = null

export function getOrchestrationEventLogSink(logsDirectory: string): LocalFileSink {
  const filePath = buildOrchestrationEventLogPath(logsDirectory)
  if (sink && sink.filePath === filePath) {
    return sink
  }
  sink?.close()
  sink = createLocalFileSink({
    filePath,
    maxBytes: EVENT_LOG_MAX_BYTES,
    maxFiles: EVENT_LOG_MAX_FILES
  })
  return sink
}

export function closeOrchestrationEventLogSink(): void {
  sink?.close()
  sink = null
}

function parseEventLines(content: string): OrchestrationEvent[] {
  const events: OrchestrationEvent[] = []
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (isOrchestrationEvent(parsed)) {
        events.push(parsed)
      }
    } catch {
      // A torn final line from a crash mid-write is expected; skip it.
    }
  }
  return events
}

/** Newest-last, across the rotated family, capped at `limit`. */
export function readOrchestrationEvents(
  logsDirectory: string,
  limit: number
): OrchestrationEvent[] {
  const filePath = buildOrchestrationEventLogPath(logsDirectory)
  sink?.flush()
  // listRotatedFiles already includes the base file, newest first.
  const files = listRotatedFiles(filePath, EVENT_LOG_MAX_FILES)
  const collected: OrchestrationEvent[] = []
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
