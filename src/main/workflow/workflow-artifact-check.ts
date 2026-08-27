// Decides whether a phase's artifact is on disk, on whichever host owns the
// workspace.
//
// The tri-state is the point: `absent` means the phase is not finished yet,
// `unreachable` means we could not find out. Collapsing them would let a dropped
// SSH connection read as "the worker never wrote its plan", which then blocks a
// phase that may well be complete.

import type { WorkspaceFileReader } from '../workspace/workspace-file-reader'

/** Bounds the fan-out of one `*` segment; a directory larger than this is not a workflow checkpoint. */
export const MAX_WORKFLOW_ARTIFACT_WILDCARD_ENTRIES = 256

export type WorkflowArtifactCheck =
  | { status: 'present'; path: string; modifiedAtMs: number | null }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

function splitAtWildcard(pattern: string): { prefix: string; suffix: string } | null {
  const segments = pattern.replace(/\\/g, '/').split('/')
  const index = segments.indexOf('*')
  if (index === -1) {
    return null
  }
  return {
    prefix: segments.slice(0, index).join('/'),
    suffix: segments.slice(index + 1).join('/')
  }
}

async function checkExact(
  reader: WorkspaceFileReader,
  path: string
): Promise<WorkflowArtifactCheck> {
  const presence = await reader.fileExists(path)
  if (presence.status === 'present') {
    return { status: 'present', path, modifiedAtMs: presence.modifiedAtMs }
  }
  return presence.status === 'absent'
    ? { status: 'absent' }
    : { status: 'unreachable', reason: presence.reason }
}

/**
 * `pattern` must already have passed `isValidWorkflowArtifactPattern`: at most
 * one whole `*` segment, no traversal. Matching is therefore a directory listing
 * plus an equality test, with no glob engine involved.
 */
export async function checkWorkflowArtifact(
  reader: WorkspaceFileReader,
  pattern: string
): Promise<WorkflowArtifactCheck> {
  const split = splitAtWildcard(pattern)
  if (!split) {
    return checkExact(reader, pattern)
  }

  const listing = await reader.readDirectory(split.prefix === '' ? '.' : split.prefix)
  if (listing.status === 'unreachable') {
    return { status: 'unreachable', reason: listing.reason }
  }
  if (listing.status === 'absent') {
    return { status: 'absent' }
  }

  // Why sorted: the first match is reported back to the user, so which one it is
  // must not depend on the host's directory order.
  const names = [...listing.names].sort().slice(0, MAX_WORKFLOW_ARTIFACT_WILDCARD_ENTRIES)
  let unreachableReason: string | null = null
  for (const name of names) {
    const candidate = [split.prefix, name, split.suffix].filter((part) => part !== '').join('/')
    const result = await checkExact(reader, candidate)
    if (result.status === 'present') {
      return result
    }
    if (result.status === 'unreachable' && unreachableReason === null) {
      unreachableReason = result.reason
    }
  }
  // A host that stopped answering mid-scan cannot prove the artifact is absent.
  return unreachableReason === null
    ? { status: 'absent' }
    : { status: 'unreachable', reason: unreachableReason }
}
