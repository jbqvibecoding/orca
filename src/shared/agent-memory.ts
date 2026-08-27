// Where an agent's long-term memory lives, and how big it is allowed to get.
//
// This is self-managed memory, not a transcript: the agent curates it, reads it
// at the start of its work, and updates it as it learns. It survives restarts,
// which is the whole point — an agent that is restarted, or a second agent
// picking up related work, should not start from nothing.

import { clampUtf8TextTail, getUtf8ByteLength } from './utf8-byte-limits'

export const AGENT_MEMORY_DIRECTORY_NAME = 'agent-memory'
export const AGENT_MEMORY_FILE_NAME = 'memory.md'

/**
 * Memory is context, and context costs tokens on every single turn. Without a
 * bound it grows monotonically until it crowds out the task itself. 64 KiB is
 * roughly a long design document — generous for curated facts, far too small to
 * hold a transcript, which is the distinction being enforced.
 */
export const MAX_AGENT_MEMORY_BYTES = 64 * 1024

/**
 * Path segments are joined onto a real directory, so they are validated rather
 * than sanitised: a handle that cannot be a directory name is a bug upstream,
 * and quietly rewriting it would put one agent's memory in another's file.
 */
export const AGENT_MEMORY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidAgentMemorySegment(segment: string): boolean {
  return AGENT_MEMORY_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..'
}

export type AgentMemoryKey = {
  /** Scopes memory to one workspace; the same agent name in another project is a different agent. */
  workspaceId: string
  agentHandle: string
}

export type AgentMemoryKeyCheck =
  | { ok: true }
  | { ok: false; field: 'workspaceId' | 'agentHandle'; reason: string }

export function checkAgentMemoryKey(key: AgentMemoryKey): AgentMemoryKeyCheck {
  for (const field of ['workspaceId', 'agentHandle'] as const) {
    if (!isValidAgentMemorySegment(key[field])) {
      return {
        ok: false,
        field,
        reason: `${field} must be 1-64 characters of letters, numbers, dot, underscore or hyphen, starting with a letter or number (got ${JSON.stringify(key[field])})`
      }
    }
  }
  return { ok: true }
}

/** Used when a coordinator has no worktree selector; that is a real, working case, not an error. */
export const UNSCOPED_AGENT_MEMORY_WORKSPACE = 'unscoped'

/**
 * Turns a workspace selector into a path segment. Hashed rather than sanitised
 * because selectors carry `/`, `::` and `:` — a rewrite that produced a legal
 * name could map two different worktrees onto one, silently merging their
 * memory. Same digest shape as ssh-relay-instance-id.ts.
 */
export function agentMemoryWorkspaceId(
  selector: string | undefined,
  digest: (input: string) => string
): string {
  if (selector === undefined || selector.trim().length === 0) {
    return UNSCOPED_AGENT_MEMORY_WORKSPACE
  }
  return `ws_${digest(selector).slice(0, 16)}`
}

export type AgentMemoryTrim = {
  text: string
  /** True when the tail was kept and older content dropped. */
  trimmed: boolean
  droppedBytes: number
}

/**
 * Keeps the tail when over budget: the newest entries are the ones an agent
 * still needs. Dropping from the front is lossy and says so — a silent trim
 * would make memory look complete while the agent's earliest decisions vanish.
 */
export function trimAgentMemory(
  text: string,
  maxBytes: number = MAX_AGENT_MEMORY_BYTES
): AgentMemoryTrim {
  const byteLength = getUtf8ByteLength(text)
  if (byteLength <= maxBytes) {
    return { text, trimmed: false, droppedBytes: 0 }
  }
  const tail = clampUtf8TextTail(text, maxBytes)
  return {
    text: tail.text,
    trimmed: true,
    droppedBytes: byteLength - getUtf8ByteLength(tail.text)
  }
}
