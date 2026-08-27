import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const DELEGATION_IS_LOCAL =
  'Delegation always runs on this machine, even when Orca is paired to a remote server: it drives the agent CLIs installed and signed in here.'

export const DELEGATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'delegate'],
    summary: "Ask another vendor's agent a bounded question and get a structured answer",
    usage:
      'orca agent delegate --briefing <text> --objective <text> [--backend <id>] [--files <glob>]... [--wait] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'briefing',
      'objective',
      'locations',
      'constraints',
      'output-contract',
      'backend',
      'model',
      'effort',
      'mode',
      'strict',
      'files',
      'label',
      'thread',
      'cwd',
      'home',
      'task-stdin',
      'wait',
      'timeout-seconds'
    ],
    examples: [
      'orca agent delegate --backend codex --briefing "TypeScript monorepo, pnpm test" --objective "Why does the lock test deadlock under load?" --files "src/**/*.ts" --wait',
      'orca agent delegate --task-stdin < task.json'
    ],
    notes: [
      DELEGATION_IS_LOCAL,
      'The delegate runs in its own process, so the calling session keeps its context.',
      '--strict executes against a directory containing only the --files whitelist, so the delegate cannot read the rest of the repo.'
    ]
  },
  {
    path: ['agent', 'delegate-show'],
    summary: 'Read the structured result of a delegated run',
    usage: 'orca agent delegate-show --run <id> [--wait] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'wait', 'timeout-seconds', 'home'],
    examples: ['orca agent delegate-show --run r-1a2b3c --wait']
  },
  {
    path: ['agent', 'delegate-doctor'],
    summary: 'Report which delegation backends are installed and signed in',
    usage: 'orca agent delegate-doctor [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'home'],
    notes: [DELEGATION_IS_LOCAL]
  },
  {
    path: ['agent', 'delegate-setup'],
    summary: 'Detect the agent CLIs on this machine and enable them for delegation',
    usage: 'orca agent delegate-setup [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'home'],
    notes: ['Run once before the first delegation; it does not overwrite existing preferences.']
  }
]
