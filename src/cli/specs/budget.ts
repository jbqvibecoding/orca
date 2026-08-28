import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SCOPE_FLAGS = ['cwd', 'host'] as const

const LAG_NOTE =
  'Spawn counts are exact. Token and spend figures come from the usage scan, so they can lag work still in flight.'

export const BUDGET_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['budget', 'show'],
    summary: 'Show budgets and what has been used against them',
    usage: 'orca budget show [--run <id>] [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'run'],
    examples: ['orca budget show', 'orca budget show --run run_abc'],
    notes: [LAG_NOTE]
  },
  {
    path: ['budget', 'set'],
    summary: 'Cap spawns, tokens and spend for a run, or globally',
    usage:
      'orca budget set [--run <id>] [--max-spawns <n>] [--max-tokens <n>] [--max-spend-usd <n>] [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...SCOPE_FLAGS,
      'run',
      'max-spawns',
      'max-tokens',
      'max-spend-usd'
    ],
    examples: [
      'orca budget set --run run_abc --max-spawns 20',
      'orca budget set --max-spend-usd 25'
    ],
    notes: [
      'Without --run the cap is the global ceiling, which applies on top of every run budget.',
      'A cap you leave out is cleared, so each command states the whole budget.',
      'Zero is a real cap that refuses every spawn; use `orca budget clear` to remove one instead.',
      'The next spawn past a cap is refused before it starts. Work already running is never interrupted.'
    ]
  },
  {
    path: ['budget', 'clear'],
    summary: 'Remove a budget, leaving the run or the machine uncapped',
    usage: 'orca budget clear [--run <id>] [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'run'],
    examples: ['orca budget clear --run run_abc', 'orca budget clear'],
    notes: ['Without --run this clears the global ceiling.']
  }
]
