import { z } from 'zod'
import { ACCEPTANCE_CHECK_NAMES } from '../../../../shared/acceptance-gate'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { orderedWorkflowPhases } from '../../../../shared/workflow-document'
import { runAcceptanceGate } from '../../../acceptance/gate-runner'
import { getOrchestrationEventLogSink } from '../../../observability/orchestration-event-log'
import { getLogsDirectory } from '../../../observability/logs-directory'
import { resolveWorkspaceFileReader } from '../../../workspace/workspace-file-reader'
import {
  listWorkflowDocuments,
  resolveWorkflowDocument,
  type WorkflowDocumentLookup
} from '../../../workflow/workflow-document-source'
import {
  advanceTaskWorkflow,
  readTaskWorkflowStatus,
  startTaskWorkflow
} from '../../../workflow/workflow-task-service'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'

const WorkspaceScope = z.object({
  cwd: z.string().min(1),
  hostId: z.string().min(1).default(LOCAL_EXECUTION_HOST_ID)
})

const ShowWorkflow = WorkspaceScope.extend({ name: z.string().min(1) })
const TaskScope = WorkspaceScope.extend({ taskId: z.string().min(1) })
// Optional: an absent name falls back to the workflow the repo pins in orca.yaml.
const StartWorkflow = TaskScope.extend({ name: z.string().min(1).optional() })
const AdvanceWorkflow = TaskScope.extend({ waiveAcceptance: z.boolean().default(false) })

function userDataPath(): string | undefined {
  try {
    return getAppEnvironment().getPath('userData')
  } catch {
    // Without Electron there is no global library; builtins still resolve.
    return undefined
  }
}

function requireWorkspace(params: z.infer<typeof WorkspaceScope>): {
  lookup: WorkflowDocumentLookup
  workspace: NonNullable<WorkflowDocumentLookup['workspace']>
} {
  const resolution = resolveWorkspaceFileReader({ cwd: params.cwd, hostId: params.hostId })
  if (resolution.status === 'unsupported') {
    throw new OrchestrationError('workflow_unreachable', resolution.reason)
  }
  return {
    workspace: resolution.reader,
    lookup: { workspace: resolution.reader, userDataPath: userDataPath() }
  }
}

export const WORKFLOW_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: 'workflow.list',
    params: WorkspaceScope,
    handler: async (params) => {
      const { lookup } = requireWorkspace(params)
      const listing = await listWorkflowDocuments(lookup)
      const workflows = await Promise.all(
        listing.map(async (entry) => {
          const resolved = await resolveWorkflowDocument(entry.name, lookup)
          return {
            name: entry.name,
            origin: entry.origin,
            description:
              resolved.status === 'resolved' ? (resolved.document.description ?? null) : null,
            // A document that no longer parses still belongs in the list; hiding
            // it would make a broken file look like a missing one.
            error: resolved.status === 'invalid' ? resolved.error : null
          }
        })
      )
      return { workflows }
    }
  }),
  defineMethod({
    name: 'workflow.show',
    params: ShowWorkflow,
    handler: async (params) => {
      const { lookup } = requireWorkspace(params)
      const resolved = await resolveWorkflowDocument(params.name, lookup)
      if (resolved.status !== 'resolved') {
        throw new OrchestrationError(
          'workflow_not_found',
          resolved.status === 'invalid'
            ? `Workflow "${params.name}" (${resolved.origin}): ${resolved.error}`
            : `No usable workflow named "${params.name}".`
        )
      }
      const { document } = resolved
      return {
        name: document.name,
        origin: resolved.origin,
        description: document.description,
        cycleTo: document.cycleTo,
        unknownKeys: document.unknownKeys,
        phases: orderedWorkflowPhases(document).map((phase) => ({
          phase,
          artifact: document.phases[phase]?.artifact ?? null,
          accepts: document.phases[phase]?.accepts ?? [],
          gate: document.phases[phase]?.gate ?? { kind: 'entry' },
          hasInstruction: (document.phases[phase]?.instruction ?? null) !== null
        }))
      }
    }
  }),
  defineMethod({
    name: 'workflow.start',
    params: StartWorkflow,
    handler: async (params, { runtime }) => {
      const { lookup, workspace } = requireWorkspace(params)
      const started = await startTaskWorkflow({
        db: runtime.getOrchestrationDb(),
        taskId: params.taskId,
        workflowName: params.name ?? null,
        workspace,
        lookup
      })
      return { taskId: params.taskId, ...started }
    }
  }),
  defineMethod({
    name: 'workflow.status',
    params: TaskScope,
    handler: async (params, { runtime }) => {
      const { lookup, workspace } = requireWorkspace(params)
      return {
        status: await readTaskWorkflowStatus({
          db: runtime.getOrchestrationDb(),
          taskId: params.taskId,
          workspace,
          lookup
        })
      }
    }
  }),
  defineMethod({
    name: 'workflow.advance',
    params: AdvanceWorkflow,
    handler: async (params, { runtime }) => {
      const { lookup, workspace } = requireWorkspace(params)
      const sink = getOrchestrationEventLogSink(getLogsDirectory())
      const decision = await advanceTaskWorkflow({
        db: runtime.getOrchestrationDb(),
        taskId: params.taskId,
        workspace,
        lookup,
        waiveAcceptance: params.waiveAcceptance,
        runAcceptance: async (checks) => {
          // Lazy: precheck-runner reaches Electron and the SSH stack through its
          // imports, and this module is loaded by every runtime method table.
          const { runAutomationPrecheck } = await import('../../../automations/precheck-runner')
          const gate = await runAcceptanceGate({
            cwd: params.cwd,
            hostId: params.hostId,
            checks: checks.length > 0 ? checks : ACCEPTANCE_CHECK_NAMES,
            runPrecheck: runAutomationPrecheck,
            emit: (event) => sink.push(event)
          })
          sink.flush()
          return gate.verdict
        }
      })
      return { decision }
    }
  })
]
