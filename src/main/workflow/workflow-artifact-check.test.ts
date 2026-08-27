import { describe, expect, it } from 'vitest'
import type {
  WorkspaceDirectoryRead,
  WorkspaceFilePresence,
  WorkspaceFileReader
} from '../workspace/workspace-file-reader'
import { checkWorkflowArtifact } from './workflow-artifact-check'

function readerOf(args: {
  files?: readonly string[]
  directories?: Readonly<Record<string, readonly string[]>>
  unreachableFiles?: readonly string[]
  unreachableDirectories?: readonly string[]
}): WorkspaceFileReader {
  const files = new Set(args.files ?? [])
  const unreachableFiles = new Set(args.unreachableFiles ?? [])
  const unreachableDirectories = new Set(args.unreachableDirectories ?? [])
  return {
    readFile: async () => ({ status: 'absent' }),
    fileExists: async (path): Promise<WorkspaceFilePresence> => {
      if (unreachableFiles.has(path)) {
        return { status: 'unreachable', reason: `host dropped while statting ${path}` }
      }
      return files.has(path) ? { status: 'present', modifiedAtMs: 1_000 } : { status: 'absent' }
    },
    readDirectory: async (path): Promise<WorkspaceDirectoryRead> => {
      if (unreachableDirectories.has(path)) {
        return { status: 'unreachable', reason: `host dropped while listing ${path}` }
      }
      const names = args.directories?.[path]
      return names ? { status: 'read', names } : { status: 'absent' }
    }
  }
}

describe('checkWorkflowArtifact', () => {
  it('finds an exact path', async () => {
    const reader = readerOf({ files: ['.orca/plan.md'] })
    expect(await checkWorkflowArtifact(reader, '.orca/plan.md')).toEqual({
      status: 'present',
      path: '.orca/plan.md',
      modifiedAtMs: 1_000
    })
  })

  it('reports an exact path that is not there as absent', async () => {
    expect(await checkWorkflowArtifact(readerOf({}), '.orca/plan.md')).toEqual({ status: 'absent' })
  })

  it('propagates an unreachable host instead of calling the artifact missing', async () => {
    const reader = readerOf({ unreachableFiles: ['.orca/plan.md'] })
    const result = await checkWorkflowArtifact(reader, '.orca/plan.md')
    expect(result.status).toBe('unreachable')
  })

  it('expands one wildcard segment through a directory listing', async () => {
    const reader = readerOf({
      directories: { '.planning/phases': ['02-auth', '01-setup'] },
      files: ['.planning/phases/02-auth/PLAN.md']
    })
    expect(await checkWorkflowArtifact(reader, '.planning/phases/*/PLAN.md')).toEqual({
      status: 'present',
      path: '.planning/phases/02-auth/PLAN.md',
      modifiedAtMs: 1_000
    })
  })

  // Which match is reported must not depend on the host's directory order.
  it('scans wildcard entries in sorted order', async () => {
    const reader = readerOf({
      directories: { out: ['b', 'a'] },
      files: ['out/a/done.md', 'out/b/done.md']
    })
    expect(await checkWorkflowArtifact(reader, 'out/*/done.md')).toEqual({
      status: 'present',
      path: 'out/a/done.md',
      modifiedAtMs: 1_000
    })
  })

  it('reports a missing wildcard parent directory as absent', async () => {
    expect(await checkWorkflowArtifact(readerOf({}), 'out/*/done.md')).toEqual({ status: 'absent' })
  })

  it('reports an unlistable wildcard parent as unreachable', async () => {
    const reader = readerOf({ unreachableDirectories: ['out'] })
    expect((await checkWorkflowArtifact(reader, 'out/*/done.md')).status).toBe('unreachable')
  })

  // Half a scan cannot prove absence.
  it('reports unreachable when a candidate could not be checked and none matched', async () => {
    const reader = readerOf({
      directories: { out: ['a', 'b'] },
      unreachableFiles: ['out/a/done.md']
    })
    const result = await checkWorkflowArtifact(reader, 'out/*/done.md')
    expect(result.status).toBe('unreachable')
  })

  // A match still wins: the artifact was observed, so the earlier failure is moot.
  it('prefers a real match over an earlier unreachable candidate', async () => {
    const reader = readerOf({
      directories: { out: ['a', 'b'] },
      unreachableFiles: ['out/a/done.md'],
      files: ['out/b/done.md']
    })
    expect(await checkWorkflowArtifact(reader, 'out/*/done.md')).toEqual({
      status: 'present',
      path: 'out/b/done.md',
      modifiedAtMs: 1_000
    })
  })

  it('handles a wildcard at the workspace root', async () => {
    const reader = readerOf({ directories: { '.': ['pkg'] }, files: ['pkg/done.md'] })
    expect(await checkWorkflowArtifact(reader, '*/done.md')).toEqual({
      status: 'present',
      path: 'pkg/done.md',
      modifiedAtMs: 1_000
    })
  })

  it('handles a trailing wildcard', async () => {
    const reader = readerOf({ directories: { out: ['done.md'] }, files: ['out/done.md'] })
    expect(await checkWorkflowArtifact(reader, 'out/*')).toEqual({
      status: 'present',
      path: 'out/done.md',
      modifiedAtMs: 1_000
    })
  })
})
