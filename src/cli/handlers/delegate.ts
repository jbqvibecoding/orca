import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { buildDelegateTaskSpec } from '../delegate-task-spec'
import { formatDelegateFailure } from '../delegate-failure-guidance'
import { describeMissingSidecar, resolveDelegateSidecar } from '../delegate-sidecar-path'
import {
  parseSidecarJson,
  runDelegateSidecar,
  type DelegateSidecarOutcome
} from '../delegate-sidecar-run'

const DEFAULT_RESULT_WAIT_SECONDS = 600

type DispatchResult = { runId: string; threadId: string; warnings: string[] }

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}

function requireSidecar(): string {
  const resolution = resolveDelegateSidecar()
  if (resolution.status === 'missing') {
    throw new RuntimeClientError('runtime_error', describeMissingSidecar(resolution.searched))
  }
  return resolution.path
}

function requireOk(outcome: DelegateSidecarOutcome): string {
  if (outcome.status === 'failed') {
    throw new RuntimeClientError('runtime_error', formatDelegateFailure(outcome.message))
  }
  return outcome.stdout
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function rejectValuelessFlag(flags: Map<string, string | boolean>, name: string): void {
  if (flags.get(name) === true) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a value.`)
  }
}

async function buildTaskDocument(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<string> {
  if (flags.get('task-stdin') === true) {
    const raw = await readStdin()
    if (raw.trim().length === 0) {
      throw new RuntimeClientError('invalid_argument', '--task-stdin was set but stdin was empty.')
    }
    return raw
  }
  for (const name of ['briefing', 'objective', 'backend', 'model', 'effort', 'mode', 'label']) {
    rejectValuelessFlag(flags, name)
  }
  const built = buildDelegateTaskSpec({
    briefing: getOptionalStringFlag(flags, 'briefing'),
    objective: getOptionalStringFlag(flags, 'objective'),
    locations: getOptionalStringFlag(flags, 'locations'),
    constraints: getOptionalStringFlag(flags, 'constraints'),
    outputContract: getOptionalStringFlag(flags, 'output-contract'),
    backend: getOptionalStringFlag(flags, 'backend'),
    model: getOptionalStringFlag(flags, 'model'),
    effort: getOptionalStringFlag(flags, 'effort'),
    mode: getOptionalStringFlag(flags, 'mode'),
    strict: flags.get('strict') === true,
    files: getRepeatedStringFlag(flags, 'files'),
    label: getOptionalStringFlag(flags, 'label'),
    thread: getOptionalStringFlag(flags, 'thread'),
    cwd: resolve(getOptionalStringFlag(flags, 'cwd') ?? cwd)
  })
  if (!built.ok) {
    throw new RuntimeClientError('invalid_argument', built.error)
  }
  return JSON.stringify(built.spec)
}

async function fetchResult(args: {
  sidecarPath: string
  runId: string
  wait: boolean
  waitSeconds: number
  home?: string
}): Promise<{ pending: boolean; payload: unknown }> {
  const argv = args.wait
    ? ['result', args.runId, '--wait', '--timeout', String(args.waitSeconds)]
    : ['result', args.runId]
  const outcome = await runDelegateSidecar({
    sidecarPath: args.sidecarPath,
    argv,
    home: args.home,
    timeoutMs: args.wait ? (args.waitSeconds + 30) * 1000 : null
  })
  if (outcome.status === 'failed') {
    throw new RuntimeClientError('runtime_error', formatDelegateFailure(outcome.message))
  }
  return { pending: outcome.status === 'pending', payload: parseSidecarJson(outcome.stdout) }
}

function formatDispatch(value: DispatchResult & { result?: unknown; pending?: boolean }): string {
  const lines = [`Delegated run ${value.runId} (thread ${value.threadId})`]
  for (const warning of value.warnings ?? []) {
    lines.push(`  warning: ${warning}`)
  }
  if (value.pending) {
    lines.push(
      '',
      `Still running. Read it later with: orca agent delegate-show --run ${value.runId}`
    )
  } else if (value.result !== undefined) {
    lines.push('', JSON.stringify(value.result, null, 2))
  } else {
    lines.push('', `Read the result with: orca agent delegate-show --run ${value.runId}`)
  }
  return lines.join('\n')
}

export const DELEGATE_HANDLERS: Record<string, CommandHandler> = {
  'agent delegate': async ({ flags, cwd, json }) => {
    const sidecarPath = requireSidecar()
    const home = getOptionalStringFlag(flags, 'home')
    const taskDocument = await buildTaskDocument(flags, cwd)
    const dispatched = parseSidecarJson<DispatchResult>(
      requireOk(
        await runDelegateSidecar({
          sidecarPath,
          argv: ['run', '--stdin'],
          input: taskDocument,
          home
        })
      )
    )
    if (!dispatched?.runId) {
      throw new RuntimeClientError(
        'runtime_error',
        'The delegate sidecar did not report a run id for the dispatched task.'
      )
    }
    if (flags.get('wait') !== true) {
      printResult(localSuccess(dispatched), json, formatDispatch)
      return
    }
    const waitSeconds =
      getOptionalPositiveIntegerFlag(flags, 'timeout-seconds') ?? DEFAULT_RESULT_WAIT_SECONDS
    const settled = await fetchResult({
      sidecarPath,
      runId: dispatched.runId,
      wait: true,
      waitSeconds,
      home
    })
    printResult(
      localSuccess({ ...dispatched, pending: settled.pending, result: settled.payload }),
      json,
      formatDispatch
    )
  },

  'agent delegate-show': async ({ flags, json }) => {
    const sidecarPath = requireSidecar()
    const settled = await fetchResult({
      sidecarPath,
      runId: getRequiredStringFlag(flags, 'run'),
      wait: flags.get('wait') === true,
      waitSeconds:
        getOptionalPositiveIntegerFlag(flags, 'timeout-seconds') ?? DEFAULT_RESULT_WAIT_SECONDS,
      home: getOptionalStringFlag(flags, 'home')
    })
    printResult(localSuccess(settled), json, (value) =>
      value.pending ? 'Still running.' : JSON.stringify(value.payload, null, 2)
    )
  },

  'agent delegate-doctor': async ({ flags, json }) => {
    const sidecarPath = requireSidecar()
    const report = requireOk(
      await runDelegateSidecar({
        sidecarPath,
        argv: ['doctor'],
        home: getOptionalStringFlag(flags, 'home')
      })
    )
    printResult(localSuccess({ sidecarPath, report }), json, (value) => value.report.trimEnd())
  },

  'agent delegate-setup': async ({ flags, json }) => {
    const sidecarPath = requireSidecar()
    const report = requireOk(
      await runDelegateSidecar({
        sidecarPath,
        argv: ['init', '--yes'],
        home: getOptionalStringFlag(flags, 'home')
      })
    )
    printResult(localSuccess({ sidecarPath, report }), json, (value) => value.report.trimEnd())
  }
}
