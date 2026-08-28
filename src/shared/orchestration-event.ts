// The append-only event log's envelope.
//
// This started life in acceptance-gate.ts as `AcceptanceEvent`, and stayed there
// while acceptance gates were the only writer. ADR-0009 requires budget
// exhaustion on the same log, and a kind named `budget.exhausted` inside a type
// called "acceptance event" would be a lie about what the log holds — so the
// envelope moved here and the acceptance kinds became one family among several.
//
// The on-disk file name does NOT change. Renaming it would orphan the logs
// already written, and the name of a file is a much smaller cost than losing the
// history in it.

import { join } from 'node:path'

/** Kinds are `<family>.<subject>.<past-tense>`; the family names the writer. */
export const ORCHESTRATION_EVENT_KINDS = [
  'acceptance.gate.started',
  'acceptance.check.settled',
  'acceptance.gate.settled',
  // ADR-0009: exhaustion is an honest stop, and a stop nobody can see later is
  // indistinguishable from a silent continue.
  'budget.exhausted'
] as const
export type OrchestrationEventKind = (typeof ORCHESTRATION_EVENT_KINDS)[number]

/**
 * Carried on every event from the first release.
 *
 * ADR-0009: spend and approval attribution cannot be backfilled onto records
 * that were written without it, so the fields exist before anything reads them.
 * `budgetId` is null when no budget was set — which is different from a budget
 * that was set and had room, and the two must stay distinguishable.
 */
export type OrchestrationEventAttribution = {
  runId: string
  workspaceId: string | null
  hostId: string
  budgetId: string | null
}

/** Envelope from oh-my-agent's event-spec, plus `attribution`. */
export type OrchestrationEvent = {
  eventId: string
  ts: string
  sid: string
  kind: OrchestrationEventKind
  writerPid: number
  vendor: string | null
  vendorSid: string | null
  parentEventId: string | null
  causalityKey: string
  attribution: OrchestrationEventAttribution
  payload: Record<string, unknown>
}

export const ORCHESTRATION_EVENT_LOG_FILE_NAME = 'acceptance-events.ndjson'

/** Callers pass the logs directory so this module stays free of Electron. */
export function buildOrchestrationEventLogPath(logsDirectory: string): string {
  return join(logsDirectory, ORCHESTRATION_EVENT_LOG_FILE_NAME)
}

export function isOrchestrationEvent(value: unknown): value is OrchestrationEvent {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.eventId === 'string' &&
    typeof record.ts === 'string' &&
    typeof record.kind === 'string' &&
    (ORCHESTRATION_EVENT_KINDS as readonly string[]).includes(record.kind) &&
    record.attribution !== null &&
    typeof record.attribution === 'object'
  )
}
