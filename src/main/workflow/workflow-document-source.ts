// Resolves a workflow document by name: project-local, then the user's global
// library, then the documents Orca ships with.
//
// A project-local document that exists but does not parse is reported as
// invalid, never fallen through to the builtin of the same name: running a
// different workflow than the one the user wrote is worse than refusing.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseWorkflowDocument,
  WORKFLOW_DOCUMENT_FILE_EXTENSION,
  WORKFLOW_NAME_PATTERN,
  type WorkflowDocument
} from '../../shared/workflow-document'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { WorkspaceFileReader } from '../workspace/workspace-file-reader'
import { BUILTIN_WORKFLOW_DOCUMENTS } from './builtin-workflow-documents'

export const PROJECT_WORKFLOW_DIRECTORY = '.orca/workflows'
export const GLOBAL_WORKFLOW_DIRECTORY_NAME = 'workflows'

export type WorkflowDocumentOrigin = 'project' | 'global' | 'builtin'

export type WorkflowDocumentResolution =
  | { status: 'resolved'; origin: WorkflowDocumentOrigin; document: WorkflowDocument }
  | { status: 'invalid'; origin: WorkflowDocumentOrigin; error: string }
  | { status: 'not-found'; searched: readonly string[] }
  | { status: 'unreachable'; reason: string }

export type WorkflowDocumentLookup = {
  /** Reader for the workspace that owns the project-local library; omit to skip it. */
  workspace?: WorkspaceFileReader
  /** Directory holding the user's global library; omit to skip it. */
  userDataPath?: string
}

function documentFileName(name: string): string {
  return `${name}${WORKFLOW_DOCUMENT_FILE_EXTENSION}`
}

function globalDirectory(userDataPath: string): string {
  return join(userDataPath, GLOBAL_WORKFLOW_DIRECTORY_NAME)
}

function parseAt(
  origin: WorkflowDocumentOrigin,
  content: string,
  expectedName: string
): WorkflowDocumentResolution {
  const parsed = parseWorkflowDocument(content)
  if (!parsed.ok) {
    return { status: 'invalid', origin, error: parsed.error }
  }
  if (parsed.document.name !== expectedName) {
    // Why refuse rather than trust the file name: the document's own name is
    // what every later record stores, so a mismatch makes state unreadable.
    return {
      status: 'invalid',
      origin,
      error: `Workflow file is named "${expectedName}" but the document declares "${parsed.document.name}".`
    }
  }
  return { status: 'resolved', origin, document: parsed.document }
}

async function readGlobalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}

export async function resolveWorkflowDocument(
  name: string,
  lookup: WorkflowDocumentLookup = {}
): Promise<WorkflowDocumentResolution> {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    return { status: 'not-found', searched: [] }
  }
  const searched: string[] = []

  if (lookup.workspace) {
    const relativePath = `${PROJECT_WORKFLOW_DIRECTORY}/${documentFileName(name)}`
    searched.push(relativePath)
    const read = await lookup.workspace.readFile(relativePath)
    if (read.status === 'unreachable') {
      return { status: 'unreachable', reason: read.reason }
    }
    if (read.status === 'read') {
      return parseAt('project', read.content, name)
    }
  }

  if (lookup.userDataPath) {
    const path = join(globalDirectory(lookup.userDataPath), documentFileName(name))
    searched.push(path)
    const content = await readGlobalFile(path)
    if (content !== null) {
      return parseAt('global', content, name)
    }
  }

  const builtin = BUILTIN_WORKFLOW_DOCUMENTS[name]
  if (builtin !== undefined) {
    return parseAt('builtin', builtin, name)
  }
  return { status: 'not-found', searched }
}

export type WorkflowDocumentListing = {
  name: string
  origin: WorkflowDocumentOrigin
}

function collectNames(fileNames: readonly string[]): string[] {
  const names: string[] = []
  for (const fileName of fileNames) {
    if (!fileName.endsWith(WORKFLOW_DOCUMENT_FILE_EXTENSION)) {
      continue
    }
    const name = fileName.slice(0, -WORKFLOW_DOCUMENT_FILE_EXTENSION.length)
    if (WORKFLOW_NAME_PATTERN.test(name)) {
      names.push(name)
    }
  }
  return names
}

/** Every reachable document name with the origin that wins for it. */
export async function listWorkflowDocuments(
  lookup: WorkflowDocumentLookup = {}
): Promise<WorkflowDocumentListing[]> {
  const byName = new Map<string, WorkflowDocumentOrigin>()
  for (const name of Object.keys(BUILTIN_WORKFLOW_DOCUMENTS)) {
    byName.set(name, 'builtin')
  }
  if (lookup.userDataPath) {
    try {
      for (const name of collectNames(await readdir(globalDirectory(lookup.userDataPath)))) {
        byName.set(name, 'global')
      }
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
    }
  }
  if (lookup.workspace) {
    const listing = await lookup.workspace.readDirectory(PROJECT_WORKFLOW_DIRECTORY)
    // A workspace we cannot reach hides project documents; the builtin and
    // global ones are still real, so report those rather than failing the list.
    if (listing.status === 'read') {
      for (const name of collectNames(listing.names)) {
        byName.set(name, 'project')
      }
    }
  }
  return [...byName.entries()]
    .map(([name, origin]) => ({ name, origin }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
