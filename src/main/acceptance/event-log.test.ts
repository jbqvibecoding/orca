import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAcceptanceEventLogPath } from '../../shared/acceptance-gate'
import {
  closeAcceptanceEventLogSink,
  createAcceptanceEvent,
  getAcceptanceEventLogSink,
  readAcceptanceEvents
} from './event-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-acceptance-log-'))
})
afterEach(() => {
  closeAcceptanceEventLogSink()
  rmSync(dir, { recursive: true, force: true })
})

const attribution = { runId: 'run-1', workspaceId: 'ws-1', hostId: 'local' }

function push(kind: Parameters<typeof createAcceptanceEvent>[0]['kind'], payload = {}) {
  getAcceptanceEventLogSink(dir).push(
    createAcceptanceEvent({ sid: 'run-1', kind, attribution, payload })
  )
}

describe('createAcceptanceEvent', () => {
  it('stamps the envelope, including attribution and a causality key', () => {
    const event = createAcceptanceEvent({
      sid: 'run-1',
      kind: 'acceptance.gate.started',
      attribution,
      payload: { cwd: '/tmp/app' }
    })
    expect(event).toMatchObject({
      sid: 'run-1',
      kind: 'acceptance.gate.started',
      writerPid: process.pid,
      vendor: null,
      vendorSid: null,
      parentEventId: null,
      causalityKey: 'acceptance:run-1',
      attribution
    })
    expect(event.eventId).toMatch(/[0-9a-f-]{36}/)
    expect(Date.parse(event.ts)).not.toBeNaN()
  })
})

describe('acceptance event log', () => {
  it('round-trips events through the NDJSON sink', () => {
    push('acceptance.gate.started', { cwd: '/tmp/app' })
    push('acceptance.gate.settled', { verdict: 'passed' })
    const events = readAcceptanceEvents(dir, 50)
    expect(events.map((event) => event.kind)).toEqual([
      'acceptance.gate.started',
      'acceptance.gate.settled'
    ])
    expect(events[1].payload).toEqual({ verdict: 'passed' })
  })

  it('writes one JSON object per line', () => {
    push('acceptance.gate.started')
    getAcceptanceEventLogSink(dir).flush()
    const raw = readFileSync(buildAcceptanceEventLogPath(dir), 'utf-8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })

  it('returns the newest events when the limit is smaller than the log', () => {
    push('acceptance.gate.started', { seq: 1 })
    push('acceptance.check.settled', { seq: 2 })
    push('acceptance.gate.settled', { seq: 3 })
    const events = readAcceptanceEvents(dir, 2)
    expect(events.map((event) => event.payload.seq)).toEqual([2, 3])
  })

  it('skips a torn final line instead of failing the read', () => {
    push('acceptance.gate.started', { seq: 1 })
    getAcceptanceEventLogSink(dir).flush()
    appendFileSync(buildAcceptanceEventLogPath(dir), '{"eventId":"partial"', 'utf-8')
    const events = readAcceptanceEvents(dir, 50)
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ seq: 1 })
  })

  it('ignores lines that parse but are not acceptance events', () => {
    push('acceptance.gate.started', { seq: 1 })
    getAcceptanceEventLogSink(dir).flush()
    appendFileSync(buildAcceptanceEventLogPath(dir), '{"hello":"world"}\n', 'utf-8')
    expect(readAcceptanceEvents(dir, 50)).toHaveLength(1)
  })

  it('returns nothing when no log exists yet', () => {
    expect(readAcceptanceEvents(dir, 50)).toEqual([])
  })

  it('reuses one sink per path and reopens after close', () => {
    const first = getAcceptanceEventLogSink(dir)
    expect(getAcceptanceEventLogSink(dir)).toBe(first)
    closeAcceptanceEventLogSink()
    expect(getAcceptanceEventLogSink(dir)).not.toBe(first)
  })
})
