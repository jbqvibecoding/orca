// Reads an agent's memory for the dispatch preamble.
//
// Every failure here is absence, not an error. Memory is context an agent is
// better off having; a dispatch that refused to run because a memory file was
// unreadable would trade a working task for a missing paragraph.

import { createHash } from 'node:crypto'
import { agentMemoryWorkspaceId } from '../../shared/agent-memory'
import { agentMemoryPath, readAgentMemory } from './memory-store'

export type DispatchMemory = {
  /** Absolute: the worker edits this from its own worktree, where a store-relative path means nothing. */
  path: string
  text: string
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function dispatchMemoryKey(args: { worktree: string | undefined; agentHandle: string }): {
  workspaceId: string
  agentHandle: string
} {
  return {
    workspaceId: agentMemoryWorkspaceId(args.worktree, sha256),
    agentHandle: args.agentHandle
  }
}

export async function loadDispatchMemory(args: {
  worktree: string | undefined
  agentHandle: string
  userDataPath?: string
}): Promise<DispatchMemory | null> {
  try {
    const key = dispatchMemoryKey(args)
    const memory = await readAgentMemory(key, args.userDataPath)
    if (!memory.exists || memory.text.trim().length === 0) {
      return null
    }
    return { path: agentMemoryPath(key, args.userDataPath), text: memory.text }
  } catch {
    return null
  }
}
