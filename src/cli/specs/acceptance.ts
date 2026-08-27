import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ACCEPTANCE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['acceptance', 'run'],
    summary: 'Run the acceptance gate (typecheck/test/lint) over a workspace',
    usage: 'orca acceptance run [--cwd <path>] [--host <id>] [--check <name>]... [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'cwd', 'host', 'check', 'timeout-seconds'],
    examples: [
      'orca acceptance run',
      'orca acceptance run --check test --check lint',
      'orca acceptance run --cwd ~/code/app --host ssh:build-box --json'
    ],
    notes: [
      'Commands come from the workspace package.json, never from the caller.',
      'Verdicts are passed / failed / unverifiable / skipped. An unreachable host is unverifiable, never failed.'
    ]
  },
  {
    path: ['acceptance', 'log'],
    summary: 'Show recent acceptance-gate events',
    usage: 'orca acceptance log [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit'],
    examples: ['orca acceptance log', 'orca acceptance log --limit 10 --json']
  }
]
