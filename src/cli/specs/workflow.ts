import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SCOPE_FLAGS = ['cwd', 'host'] as const

export const WORKFLOW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['workflow', 'list'],
    summary: 'List workflow documents and where each one is resolved from',
    usage: 'orca workflow list [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS],
    examples: ['orca workflow list', 'orca workflow list --json'],
    notes: [
      'Resolution order: .orca/workflows in the project, then your global library, then the builtins.'
    ]
  },
  {
    path: ['workflow', 'show'],
    summary: 'Show a workflow document: its phases, artifacts, and acceptance checks',
    usage: 'orca workflow show --workflow <name> [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'workflow'],
    examples: ['orca workflow show --workflow standard']
  },
  {
    path: ['workflow', 'start'],
    summary: 'Put a task on a workflow, starting at its first phase',
    usage:
      'orca workflow start --task <id> [--workflow <name>] [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'task', 'workflow'],
    examples: ['orca workflow start --task task_abc --workflow standard'],
    notes: [
      'Without --workflow, the workflow named by `workflow:` in the repo orca.yaml is used.',
      'Starting again resets the task to the first phase and clears its cycle counter.'
    ]
  },
  {
    path: ['workflow', 'status'],
    summary: "Show a task's current phase and whether it can advance",
    usage: 'orca workflow status --task <id> [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'task'],
    examples: ['orca workflow status --task task_abc']
  },
  {
    path: ['workflow', 'advance'],
    summary: 'Advance a task to its next phase once its artifact and gate allow it',
    usage:
      'orca workflow advance --task <id> [--waive-acceptance] [--cwd <path>] [--host <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SCOPE_FLAGS, 'task', 'waive-acceptance'],
    examples: [
      'orca workflow advance --task task_abc',
      'orca workflow advance --task task_abc --waive-acceptance'
    ],
    notes: [
      'The phase artifact is checked first; the acceptance gate runs only once that file exists.',
      'A gate that could not be verified blocks the advance too — unverifiable is not passed.',
      '--waive-acceptance skips the gate for this one advance. It never skips the artifact check.'
    ]
  }
]
