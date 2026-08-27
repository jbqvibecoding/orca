import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import type { WorkflowPhaseGate } from '../../shared/workflow-phase'

type Listing = {
  workflows: { name: string; origin: string; description: string | null; error: string | null }[]
}

type PhaseView = {
  phase: string
  artifact: string | null
  accepts: string[]
  gate: WorkflowPhaseGate
  hasInstruction: boolean
}

type DocumentView = {
  name: string
  origin: string
  description: string | null
  cycleTo: string | null
  unknownKeys: string[]
  phases: PhaseView[]
}

type StatusView = {
  status: {
    taskId: string
    workflow: string
    origin: string
    phase: string
    cycle: number
    artifact: string | null
    artifactStatus: 'present' | 'absent' | 'unreachable' | 'none'
    accepts: string[]
    lastRefusal: { cause: string; reason: string } | null
  }
}

type DecisionView = {
  decision:
    | { kind: 'advance'; from: string; to: string; cycle: number }
    | { kind: 'finished'; from: string; cycle: number }
    | { kind: 'refused'; cause: string; reason: string }
}

function rejectValuelessFlag(flags: Map<string, string | boolean>, name: string): void {
  if (flags.get(name) === true) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a value.`)
  }
}

function scope(
  flags: Map<string, string | boolean>,
  cwd: string
): { cwd: string; hostId?: string } {
  rejectValuelessFlag(flags, 'cwd')
  rejectValuelessFlag(flags, 'host')
  return {
    cwd: resolve(getOptionalStringFlag(flags, 'cwd') ?? cwd),
    hostId: getOptionalStringFlag(flags, 'host')
  }
}

function requireWorkflowName(flags: Map<string, string | boolean>): string {
  rejectValuelessFlag(flags, 'workflow')
  return getRequiredStringFlag(flags, 'workflow')
}

function formatListing(value: Listing): string {
  if (value.workflows.length === 0) {
    return 'No workflow documents found.'
  }
  return value.workflows
    .map((entry) => {
      const detail = entry.error ? `BROKEN — ${entry.error}` : (entry.description ?? '')
      return `${entry.name.padEnd(20)} ${entry.origin.padEnd(8)} ${detail}`.trimEnd()
    })
    .join('\n')
}

function describeGate(gate: WorkflowPhaseGate): string {
  return gate.kind === 'entry'
    ? 'can start here'
    : `waits for ${gate.predecessor} to write ${gate.artifact}`
}

function formatDocument(value: DocumentView): string {
  const lines = [`${value.name} (${value.origin})`]
  if (value.description) {
    lines.push(value.description)
  }
  lines.push('')
  for (const phase of value.phases) {
    lines.push(`  ${phase.phase}`)
    lines.push(`    ${describeGate(phase.gate)}`)
    lines.push(`    artifact: ${phase.artifact ?? '(none)'}`)
    lines.push(`    acceptance: ${phase.accepts.length > 0 ? phase.accepts.join(', ') : '(none)'}`)
    if (!phase.hasInstruction) {
      lines.push('    instruction: (none — the worker gets the task with no phase guidance)')
    }
  }
  if (value.cycleTo) {
    lines.push('', `After the last phase this workflow returns to ${value.cycleTo}.`)
  }
  if (value.unknownKeys.length > 0) {
    lines.push(
      '',
      `Ignored by this build (a newer Orca may understand them): ${value.unknownKeys.join(', ')}`
    )
  }
  return lines.join('\n')
}

const ARTIFACT_SUMMARY: Record<StatusView['status']['artifactStatus'], string> = {
  present: 'written',
  absent: 'not written yet',
  unreachable: 'could not be checked',
  none: 'no artifact declared'
}

function formatStatus(value: StatusView): string {
  const { status } = value
  const pass = status.cycle > 0 ? ` (pass ${status.cycle + 1})` : ''
  const lines = [
    `${status.taskId} — ${status.workflow} (${status.origin}), phase ${status.phase}${pass}`,
    `  artifact: ${status.artifact ?? '(none)'} — ${ARTIFACT_SUMMARY[status.artifactStatus]}`,
    `  acceptance: ${status.accepts.length > 0 ? status.accepts.join(', ') : '(none)'}`
  ]
  if (status.lastRefusal) {
    lines.push(`  last refused (${status.lastRefusal.cause}): ${status.lastRefusal.reason}`)
  }
  return lines.join('\n')
}

function formatDecision(value: DecisionView): string {
  const { decision } = value
  if (decision.kind === 'advance') {
    const pass = decision.cycle > 0 ? ` (pass ${decision.cycle + 1})` : ''
    return `Advanced from ${decision.from} to ${decision.to}${pass}.`
  }
  if (decision.kind === 'finished') {
    return `The ${decision.from} phase was the last one; this workflow is complete.`
  }
  return `Did not advance (${decision.cause}): ${decision.reason}`
}

export const WORKFLOW_HANDLERS: Record<string, CommandHandler> = {
  'workflow list': async ({ flags, client, cwd, json }) => {
    printResult(await client.call<Listing>('workflow.list', scope(flags, cwd)), json, formatListing)
  },

  'workflow show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<DocumentView>('workflow.show', {
      ...scope(flags, cwd),
      name: requireWorkflowName(flags)
    })
    printResult(result, json, formatDocument)
  },

  'workflow start': async ({ flags, client, cwd, json }) => {
    rejectValuelessFlag(flags, 'task')
    rejectValuelessFlag(flags, 'workflow')
    const result = await client.call<{ taskId: string; workflow: string; phase: string }>(
      'workflow.start',
      {
        ...scope(flags, cwd),
        taskId: getRequiredStringFlag(flags, 'task'),
        // Absent is legal: the runtime falls back to the workflow orca.yaml pins.
        name: getOptionalStringFlag(flags, 'workflow')
      }
    )
    printResult(
      result,
      json,
      (value) => `${value.taskId} is on ${value.workflow}, starting at ${value.phase}.`
    )
  },

  'workflow status': async ({ flags, client, cwd, json }) => {
    rejectValuelessFlag(flags, 'task')
    const result = await client.call<StatusView>('workflow.status', {
      ...scope(flags, cwd),
      taskId: getRequiredStringFlag(flags, 'task')
    })
    printResult(result, json, formatStatus)
  },

  'workflow advance': async ({ flags, client, cwd, json }) => {
    rejectValuelessFlag(flags, 'task')
    const result = await client.call<DecisionView>('workflow.advance', {
      ...scope(flags, cwd),
      taskId: getRequiredStringFlag(flags, 'task'),
      waiveAcceptance: flags.get('waive-acceptance') === true
    })
    printResult(result, json, formatDecision)
  }
}
