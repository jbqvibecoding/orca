// Reads and writes per-agent memory files.
//
// Location is deliberately Orca's own state directory, not the user's
// workspace. ADR-0008 describes memory as files in a repository with the
// supervising process as the only committer; putting that repository in the
// user's project would mean Orca starts creating commits in their history,
// which it has never done and which is hard to undo. Orca's own directory keeps
// the audit trail and leaves the user's history alone — and makes the
// folder-workspace case work for free, since it does not depend on the
// workspace being a git repo at all.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_MEMORY_DIRECTORY_NAME,
  AGENT_MEMORY_FILE_NAME,
  checkAgentMemoryKey,
  MAX_AGENT_MEMORY_BYTES,
  trimAgentMemory,
  type AgentMemoryKey
} from '../../shared/agent-memory'
import { getAppEnvironment } from '../../shared/app-environment'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { redactString } from '../observability/redactor'

export function getAgentMemoryRoot(userDataPath?: string): string {
  const base = userDataPath ?? getAppEnvironment().getPath('userData')
  return join(base, AGENT_MEMORY_DIRECTORY_NAME)
}

/** Repo-relative so the same string names the file on disk and inside the audit repo. */
export function agentMemoryRelativePath(key: AgentMemoryKey): string {
  const checked = checkAgentMemoryKey(key)
  if (!checked.ok) {
    throw new Error(`Invalid agent memory ${checked.field}: ${checked.reason}`)
  }
  return `${key.workspaceId}/${key.agentHandle}/${AGENT_MEMORY_FILE_NAME}`
}

export function agentMemoryPath(key: AgentMemoryKey, userDataPath?: string): string {
  return join(getAgentMemoryRoot(userDataPath), ...agentMemoryRelativePath(key).split('/'))
}

export type AgentMemoryRead = {
  /** Empty string when the agent has no memory yet; absent memory is normal, not an error. */
  text: string
  exists: boolean
}

export async function readAgentMemory(
  key: AgentMemoryKey,
  userDataPath?: string
): Promise<AgentMemoryRead> {
  try {
    return { text: await readFile(agentMemoryPath(key, userDataPath), 'utf-8'), exists: true }
  } catch (error) {
    if (isENOENT(error)) {
      return { text: '', exists: false }
    }
    throw error
  }
}

export type AgentMemoryWrite = {
  path: string
  relativePath: string
  bytes: number
  trimmed: boolean
  droppedBytes: number
  /** True when redaction changed the text on its way in. */
  redacted: boolean
}

async function writeMemoryText(
  key: AgentMemoryKey,
  text: string,
  userDataPath: string | undefined,
  maxBytes: number
): Promise<AgentMemoryWrite> {
  // Memory holds whatever the agent wrote, including a key it pasted without
  // thinking. Redact on the way in, not on the way out: once it is on disk it
  // is in the audit repo's history too.
  const redactedText = redactString(text)
  const trim = trimAgentMemory(redactedText, maxBytes)
  const path = agentMemoryPath(key, userDataPath)
  await mkdir(join(path, '..'), { recursive: true })
  // Write-then-rename: a crash mid-write must not leave the agent with a
  // half-truncated memory it will read back as fact next turn.
  const staging = `${path}.writing`
  await writeFile(staging, trim.text, 'utf-8')
  await rename(staging, path)
  return {
    path,
    relativePath: agentMemoryRelativePath(key),
    bytes: Buffer.byteLength(trim.text, 'utf-8'),
    trimmed: trim.trimmed,
    droppedBytes: trim.droppedBytes,
    redacted: redactedText !== text
  }
}

export async function replaceAgentMemory(args: {
  key: AgentMemoryKey
  text: string
  userDataPath?: string
  maxBytes?: number
}): Promise<AgentMemoryWrite> {
  return writeMemoryText(
    args.key,
    args.text,
    args.userDataPath,
    args.maxBytes ?? MAX_AGENT_MEMORY_BYTES
  )
}

export async function appendAgentMemory(args: {
  key: AgentMemoryKey
  entry: string
  userDataPath?: string
  maxBytes?: number
}): Promise<AgentMemoryWrite> {
  const existing = await readAgentMemory(args.key, args.userDataPath)
  const separator = existing.text.length > 0 && !existing.text.endsWith('\n') ? '\n' : ''
  return writeMemoryText(
    args.key,
    `${existing.text}${separator}${args.entry}`,
    args.userDataPath,
    args.maxBytes ?? MAX_AGENT_MEMORY_BYTES
  )
}
