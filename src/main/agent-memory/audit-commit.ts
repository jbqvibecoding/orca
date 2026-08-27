// The single entry point for committing agent memory.
//
// One queue per memory root, held here rather than constructed at each call
// site. Two queues over one directory would reintroduce exactly the concurrent
// `.git/index.lock` corruption AgentMemoryCommitQueue exists to prevent, and a
// second `new AgentMemoryCommitQueue(root)` somewhere else is an easy mistake to
// make — so there is one place that can make it.

import { hasAppEnvironment } from '../../shared/app-environment'
import { AgentMemoryCommitQueue, type MemoryCommitOutcome } from './commit-queue'
import { getAgentMemoryRoot } from './memory-store'

const queues = new Map<string, AgentMemoryCommitQueue>()

function queueFor(root: string): AgentMemoryCommitQueue {
  const existing = queues.get(root)
  if (existing) {
    return existing
  }
  const created = new AgentMemoryCommitQueue(root)
  queues.set(root, created)
  return created
}

/**
 * Records the current state of agent memory in its audit history. Never throws
 * and never rejects: an audit write that failed must not take down the
 * checkpoint that triggered it.
 */
export async function commitAgentMemory(
  reason: string,
  userDataPath?: string
): Promise<MemoryCommitOutcome> {
  // A plain-Node fork or a unit test has no app paths to resolve, and there is
  // nothing to audit there anyway.
  if (userDataPath === undefined && !hasAppEnvironment()) {
    return { status: 'unavailable', reason: 'no app environment is installed' }
  }
  try {
    return await queueFor(getAgentMemoryRoot(userDataPath)).enqueue(reason)
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Test seam: drops the cached queues so a test's temporary root does not leak into the next one. */
export function resetAgentMemoryCommitQueues(): void {
  queues.clear()
}
