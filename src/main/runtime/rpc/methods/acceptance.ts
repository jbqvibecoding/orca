import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  ACCEPTANCE_CHECK_NAMES,
  type AcceptanceCheckName
} from '../../../../shared/acceptance-gate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { runAcceptanceGate } from '../../../acceptance/gate-runner'
import {
  getOrchestrationEventLogSink,
  readOrchestrationEvents
} from '../../../observability/orchestration-event-log'
import { getLogsDirectory } from '../../../observability/logs-directory'

const MAX_EVENT_LOG_LIMIT = 500
const DEFAULT_EVENT_LOG_LIMIT = 50

// The check name is an enum at the wire boundary, so an unlisted command is
// rejected by the schema rather than by a runtime branch someone can forget.
const RunAcceptanceGate = z.object({
  cwd: z.string().min(1),
  hostId: z.string().min(1).default(LOCAL_EXECUTION_HOST_ID),
  checks: z.array(z.enum(ACCEPTANCE_CHECK_NAMES)).min(1).optional(),
  workspaceId: z.string().nullable().optional(),
  timeoutSeconds: z.number().int().positive().optional()
})

const ReadAcceptanceLog = z.object({
  limit: z.number().int().positive().max(MAX_EVENT_LOG_LIMIT).default(DEFAULT_EVENT_LOG_LIMIT)
})

export const ACCEPTANCE_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: 'acceptance.run',
    params: RunAcceptanceGate,
    handler: async (params) => {
      // Lazy: precheck-runner reaches Electron and the SSH stack through its
      // imports, and this module is loaded by every runtime method table.
      const { runAutomationPrecheck } = await import('../../../automations/precheck-runner')
      const sink = getOrchestrationEventLogSink(getLogsDirectory())
      const checks: readonly AcceptanceCheckName[] = params.checks ?? ACCEPTANCE_CHECK_NAMES
      const result = await runAcceptanceGate({
        cwd: params.cwd,
        hostId: params.hostId,
        checks,
        workspaceId: params.workspaceId ?? null,
        timeoutSeconds: params.timeoutSeconds,
        runPrecheck: runAutomationPrecheck,
        emit: (event) => sink.push(event)
      })
      sink.flush()
      return { gate: result }
    }
  }),
  defineMethod({
    name: 'acceptance.log',
    params: ReadAcceptanceLog,
    handler: (params) => {
      const events = readOrchestrationEvents(getLogsDirectory(), params.limit)
      return { events, count: events.length }
    }
  })
]
