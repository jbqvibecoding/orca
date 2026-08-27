// Reads the manifest files an acceptance gate needs, on whichever host owns
// the workspace.
//
// Tri-state on purpose. Orca's other local/SSH readers collapse "file is not
// there" and "host did not answer" into `null`, which is fine for a setup-script
// suggestion and wrong here: absent means `skipped` (no gate) while unreachable
// means `unverifiable` (the gate could not run). Conflating them would let a
// dropped SSH connection read as "this project has no tests".

import { readFile, stat } from 'node:fs/promises'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

export type WorkspaceFileRead =
  | { status: 'read'; content: string }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

export type WorkspaceFilePresence =
  | { status: 'present' }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

export type WorkspaceManifestReader = {
  readFile(relativePath: string): Promise<WorkspaceFileRead>
  fileExists(relativePath: string): Promise<WorkspaceFilePresence>
}

function unreachable(reason: string): { status: 'unreachable'; reason: string } {
  return { status: 'unreachable', reason }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createLocalReader(cwd: string): WorkspaceManifestReader {
  return {
    readFile: async (relativePath) => {
      try {
        return {
          status: 'read',
          content: await readFile(joinWorktreeRelativePath(cwd, relativePath), 'utf-8')
        }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not read ${relativePath}: ${describe(error)}`)
      }
    },
    fileExists: async (relativePath) => {
      try {
        const fileStat = await stat(joinWorktreeRelativePath(cwd, relativePath))
        return fileStat.isDirectory() ? { status: 'absent' } : { status: 'present' }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not stat ${relativePath}: ${describe(error)}`)
      }
    }
  }
}

function createSshReader(cwd: string, targetId: string): WorkspaceManifestReader {
  const requireProvider = () => {
    const provider = getSshFilesystemProvider(targetId)
    return provider ?? null
  }
  return {
    readFile: async (relativePath) => {
      const provider = requireProvider()
      if (!provider) {
        return unreachable(`SSH host ${targetId} is not connected`)
      }
      try {
        const result = await provider.readFile(joinWorktreeRelativePath(cwd, relativePath))
        // Why absent, not unreachable: a binary package.json is a real file we
        // cannot use, which is a missing manifest, not a missing host.
        return result.isBinary ? { status: 'absent' } : { status: 'read', content: result.content }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not read ${relativePath} on ${targetId}: ${describe(error)}`)
      }
    },
    fileExists: async (relativePath) => {
      const provider = requireProvider()
      if (!provider) {
        return unreachable(`SSH host ${targetId} is not connected`)
      }
      try {
        const fileStat = await provider.stat(joinWorktreeRelativePath(cwd, relativePath))
        return fileStat.type === 'directory' ? { status: 'absent' } : { status: 'present' }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not stat ${relativePath} on ${targetId}: ${describe(error)}`)
      }
    }
  }
}

export type WorkspaceManifestReaderResolution =
  | { status: 'ready'; reader: WorkspaceManifestReader }
  | { status: 'unsupported'; reason: string }

export function resolveWorkspaceManifestReader(args: {
  cwd: string
  hostId: string
}): WorkspaceManifestReaderResolution {
  const parsed = parseExecutionHostId(args.hostId)
  if (!parsed) {
    return { status: 'unsupported', reason: `unknown execution host "${args.hostId}"` }
  }
  if (parsed.kind === 'local') {
    return { status: 'ready', reader: createLocalReader(args.cwd) }
  }
  if (parsed.kind === 'ssh') {
    return { status: 'ready', reader: createSshReader(args.cwd, parsed.targetId) }
  }
  // Runtime hosts own their own execution; a client cannot read their disk.
  return {
    status: 'unsupported',
    reason: `acceptance gates cannot run against ${parsed.id} from here; run them on that Orca server`
  }
}

export { LOCAL_EXECUTION_HOST_ID }
