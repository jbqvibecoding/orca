// Reads files out of a workspace, on whichever host owns it. Used by acceptance
// gates (manifests) and by workflow phases (instruction documents, artifacts).
//
// Tri-state on purpose. Orca's other local/SSH readers collapse "file is not
// there" and "host did not answer" into `null`, which is fine for a setup-script
// suggestion and wrong here: absent means `skipped` (no gate) or "phase not
// finished" while unreachable means `unverifiable`. Conflating them would let a
// dropped SSH connection read as "this project has no tests".

import { readdir, readFile, stat } from 'node:fs/promises'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

export type WorkspaceFileRead =
  | { status: 'read'; content: string }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

export type WorkspaceFilePresence =
  // `modifiedAtMs` is null when the host cannot report one; callers must treat
  // that as "unknown", never as "old".
  | { status: 'present'; modifiedAtMs: number | null }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

export type WorkspaceDirectoryRead =
  | { status: 'read'; names: readonly string[] }
  | { status: 'absent' }
  | { status: 'unreachable'; reason: string }

export type WorkspaceFileReader = {
  readFile(relativePath: string): Promise<WorkspaceFileRead>
  fileExists(relativePath: string): Promise<WorkspaceFilePresence>
  /** Entry names directly inside `relativePath`; `absent` when the directory is not there. */
  readDirectory(relativePath: string): Promise<WorkspaceDirectoryRead>
}

function unreachable(reason: string): { status: 'unreachable'; reason: string } {
  return { status: 'unreachable', reason }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Why the message is consulted too: an SSH host's error crosses the relay as
// JSON-RPC and is rebuilt with the transport's own code, same reason isENOENT does it.
function isENOTDIR(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (error as NodeJS.ErrnoException).code === 'ENOTDIR' || error.message.includes('ENOTDIR')
}

function createLocalReader(cwd: string): WorkspaceFileReader {
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
        return fileStat.isDirectory()
          ? { status: 'absent' }
          : { status: 'present', modifiedAtMs: fileStat.mtimeMs }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not stat ${relativePath}: ${describe(error)}`)
      }
    },
    readDirectory: async (relativePath) => {
      try {
        const entries = await readdir(joinWorktreeRelativePath(cwd, relativePath))
        return { status: 'read', names: entries }
      } catch (error) {
        // ENOTDIR is a path that exists but is not a directory: nothing to list,
        // which is absent, not a host that failed to answer.
        return isENOENT(error) || isENOTDIR(error)
          ? { status: 'absent' }
          : unreachable(`could not list ${relativePath}: ${describe(error)}`)
      }
    }
  }
}

function createSshReader(cwd: string, targetId: string): WorkspaceFileReader {
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
        // `mtime` is milliseconds across providers (ssh-filesystem-provider-sftp
        // multiplies SFTP's seconds); `mtimeMs` is the optional finer value.
        return fileStat.type === 'directory'
          ? { status: 'absent' }
          : { status: 'present', modifiedAtMs: fileStat.mtimeMs ?? fileStat.mtime }
      } catch (error) {
        return isENOENT(error)
          ? { status: 'absent' }
          : unreachable(`could not stat ${relativePath} on ${targetId}: ${describe(error)}`)
      }
    },
    readDirectory: async (relativePath) => {
      const provider = requireProvider()
      if (!provider) {
        return unreachable(`SSH host ${targetId} is not connected`)
      }
      try {
        const entries = await provider.readDir(joinWorktreeRelativePath(cwd, relativePath))
        return { status: 'read', names: entries.map((entry) => entry.name) }
      } catch (error) {
        return isENOENT(error) || isENOTDIR(error)
          ? { status: 'absent' }
          : unreachable(`could not list ${relativePath} on ${targetId}: ${describe(error)}`)
      }
    }
  }
}

export type WorkspaceFileReaderResolution =
  | { status: 'ready'; reader: WorkspaceFileReader }
  | { status: 'unsupported'; reason: string }

export function resolveWorkspaceFileReader(args: {
  cwd: string
  hostId: string
}): WorkspaceFileReaderResolution {
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
    reason: `cannot read a workspace on ${parsed.id} from here; run this on that Orca server`
  }
}

export { LOCAL_EXECUTION_HOST_ID }
