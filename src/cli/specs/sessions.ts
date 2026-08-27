import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// No --host: the index reads this machine's agent history, so answering from a
// paired remote runtime would describe the wrong machine. See
// src/cli/session-index-sidecar-run.ts.
const INDEX_NOTE =
  'Reads agent sessions on this machine, including ones started outside Orca. Other tools’ files are opened read-only.'

export const SESSIONS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['sessions', 'search'],
    summary: 'Search across agent sessions on this machine, whatever tool created them',
    usage:
      'orca sessions search --query <text> [--agent <id>]... [--project <path>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'agent', 'project', 'limit'],
    examples: [
      'orca sessions search --query "useEffect cleanup"',
      'orca sessions search --query rate-limit --agent codex --limit 10'
    ],
    notes: [
      INDEX_NOTE,
      'Matches are marked [[hl]]…[[/hl]] in each snippet.',
      'A query under three characters cannot use the index and falls back to a slower scan; the result says so.'
    ]
  },
  {
    path: ['sessions', 'list'],
    summary: 'List indexed agent sessions, most recently updated first',
    usage:
      'orca sessions list [--agent <id>]... [--project <path>] [--title <text>] [--limit <n>] [--offset <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'project', 'title', 'limit', 'offset'],
    examples: ['orca sessions list --limit 20', 'orca sessions list --agent claude-code'],
    notes: [INDEX_NOTE]
  },
  {
    path: ['sessions', 'reindex'],
    summary: 'Rescan this machine for agent sessions',
    usage: 'orca sessions reindex [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'full'],
    examples: ['orca sessions reindex', 'orca sessions reindex --full'],
    notes: [
      INDEX_NOTE,
      'The index is disposable: it can be rebuilt at any time and is not the source of truth for anything.',
      '--full re-reads every session instead of only what changed.'
    ]
  },
  {
    path: ['sessions', 'doctor'],
    summary: 'Report where the session index lives and which agents it can read',
    usage: 'orca sessions doctor [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca sessions doctor'],
    notes: [
      INDEX_NOTE,
      'Run this first when search returns nothing: it names the sidecar and how many sessions are indexed.'
    ]
  }
]
