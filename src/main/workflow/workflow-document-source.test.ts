import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseWorkflowDocument } from '../../shared/workflow-document'
import { resolveEntryPhase } from './phase-transition'
import type {
  WorkspaceDirectoryRead,
  WorkspaceFileRead,
  WorkspaceFileReader
} from '../workspace/workspace-file-reader'
import { BUILTIN_WORKFLOW_DOCUMENTS, DEFAULT_WORKFLOW_NAME } from './builtin-workflow-documents'
import {
  GLOBAL_WORKFLOW_DIRECTORY_NAME,
  listWorkflowDocuments,
  resolveWorkflowDocument
} from './workflow-document-source'

const PROJECT_DOC = 'name: standard\nphases:\n  planning:\n    instruction: "Plan: {task}"\n'

function workspaceOf(args: {
  files?: Readonly<Record<string, string>>
  directories?: Readonly<Record<string, readonly string[]>>
  unreachable?: boolean
}): WorkspaceFileReader {
  return {
    readFile: async (path): Promise<WorkspaceFileRead> => {
      if (args.unreachable) {
        return { status: 'unreachable', reason: 'SSH host build-01 is not connected' }
      }
      const content = args.files?.[path]
      return content === undefined ? { status: 'absent' } : { status: 'read', content }
    },
    fileExists: async () => ({ status: 'absent' }),
    readDirectory: async (path): Promise<WorkspaceDirectoryRead> => {
      if (args.unreachable) {
        return { status: 'unreachable', reason: 'SSH host build-01 is not connected' }
      }
      const names = args.directories?.[path]
      return names ? { status: 'read', names } : { status: 'absent' }
    }
  }
}

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-workflow-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function writeGlobal(name: string, content: string): void {
  const directory = join(userDataPath, GLOBAL_WORKFLOW_DIRECTORY_NAME)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${name}.yaml`), content, 'utf-8')
}

describe('builtin documents', () => {
  it('every shipped document parses and declares a startable phase', () => {
    for (const [name, content] of Object.entries(BUILTIN_WORKFLOW_DOCUMENTS)) {
      const parsed = parseWorkflowDocument(content)
      expect(parsed.ok, `${name}: ${parsed.ok ? '' : parsed.error}`).toBe(true)
      if (!parsed.ok) {
        continue
      }
      expect(parsed.document.name).toBe(name)
      expect(resolveEntryPhase(parsed.document)).not.toBeNull()
    }
  })

  it('ships the default workflow', () => {
    expect(BUILTIN_WORKFLOW_DOCUMENTS[DEFAULT_WORKFLOW_NAME]).toBeDefined()
  })
})

describe('resolveWorkflowDocument', () => {
  it('falls back to the builtin when nothing overrides it', async () => {
    const resolution = await resolveWorkflowDocument(DEFAULT_WORKFLOW_NAME, { userDataPath })
    expect(resolution).toMatchObject({ status: 'resolved', origin: 'builtin' })
  })

  it('prefers the global library over the builtin', async () => {
    writeGlobal('standard', PROJECT_DOC)
    const resolution = await resolveWorkflowDocument('standard', { userDataPath })
    expect(resolution).toMatchObject({ status: 'resolved', origin: 'global' })
  })

  it('prefers the project library over both', async () => {
    writeGlobal('standard', PROJECT_DOC)
    const resolution = await resolveWorkflowDocument('standard', {
      userDataPath,
      workspace: workspaceOf({ files: { '.orca/workflows/standard.yaml': PROJECT_DOC } })
    })
    expect(resolution).toMatchObject({ status: 'resolved', origin: 'project' })
  })

  // Running a different workflow than the one the user wrote is worse than refusing.
  it('reports an invalid project document instead of falling through to the builtin', async () => {
    const resolution = await resolveWorkflowDocument('standard', {
      userDataPath,
      workspace: workspaceOf({ files: { '.orca/workflows/standard.yaml': 'name: [broken\n' } })
    })
    expect(resolution).toMatchObject({ status: 'invalid', origin: 'project' })
  })

  it('refuses a document whose declared name does not match its file', async () => {
    writeGlobal('standard', 'name: other\nphases:\n  planning:\n    instruction: "{task}"\n')
    const resolution = await resolveWorkflowDocument('standard', { userDataPath })
    expect(resolution).toMatchObject({ status: 'invalid', origin: 'global' })
    expect(resolution.status === 'invalid' && resolution.error).toContain('declares "other"')
  })

  // An unreachable workspace is not proof that no project document exists.
  it('reports an unreachable workspace rather than using the builtin', async () => {
    const resolution = await resolveWorkflowDocument('standard', {
      userDataPath,
      workspace: workspaceOf({ unreachable: true })
    })
    expect(resolution).toMatchObject({ status: 'unreachable' })
  })

  it('reports what it searched when the name is unknown', async () => {
    const resolution = await resolveWorkflowDocument('nope', {
      userDataPath,
      workspace: workspaceOf({})
    })
    expect(resolution.status).toBe('not-found')
    expect(resolution.status === 'not-found' && resolution.searched).toHaveLength(2)
  })

  it('rejects a name that could escape the library directory', async () => {
    const resolution = await resolveWorkflowDocument('../../etc/passwd', { userDataPath })
    expect(resolution).toEqual({ status: 'not-found', searched: [] })
  })
})

describe('listWorkflowDocuments', () => {
  it('lists builtins when nothing else is present', async () => {
    const listing = await listWorkflowDocuments({ userDataPath })
    expect(listing.map((entry) => entry.name)).toEqual(
      Object.keys(BUILTIN_WORKFLOW_DOCUMENTS).sort()
    )
    expect(listing.every((entry) => entry.origin === 'builtin')).toBe(true)
  })

  it('reports the origin that wins for each name', async () => {
    writeGlobal('standard', PROJECT_DOC)
    writeGlobal('mine', PROJECT_DOC)
    const listing = await listWorkflowDocuments({
      userDataPath,
      workspace: workspaceOf({ directories: { '.orca/workflows': ['mine.yaml', 'notes.txt'] } })
    })
    expect(listing).toContainEqual({ name: 'standard', origin: 'global' })
    expect(listing).toContainEqual({ name: 'mine', origin: 'project' })
    expect(listing.some((entry) => entry.name === 'notes')).toBe(false)
  })

  // The builtin and global documents are still real when the workspace is gone.
  it('still lists reachable documents when the workspace cannot be read', async () => {
    const listing = await listWorkflowDocuments({
      userDataPath,
      workspace: workspaceOf({ unreachable: true })
    })
    expect(listing.length).toBe(Object.keys(BUILTIN_WORKFLOW_DOCUMENTS).length)
  })
})
