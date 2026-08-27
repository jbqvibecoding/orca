// Locates the session-index sidecar across the layouts it can ship in.
//
// Same candidate-list shape as getDelegateSidecarCandidates(), with one
// difference that matters: this sidecar is a native executable, not a script,
// so the file name carries a platform suffix and it is spawned directly rather
// than through process.execPath.
//
// It ships as an extraResource for the same reason the delegate bundle does —
// an executable cannot be run from inside an asar archive.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_INDEX_SIDECAR_PATH_ENV = 'ORCA_SESSION_INDEX_PATH'

export function sessionIndexFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'wake-index.exe' : 'wake-index'
}

/** Electron augments `process` with this; the CLI's type surface does not. */
function packagedResourcesPath(override: string | undefined): string | undefined {
  if (override !== undefined) {
    return override
  }
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

export function getSessionIndexCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const candidates: string[] = []
  const override = env[SESSION_INDEX_SIDECAR_PATH_ENV]
  if (override) {
    candidates.push(override)
  }
  const fileName = sessionIndexFileName(platform)
  const packaged = packagedResourcesPath(resourcesPath)
  if (packaged) {
    candidates.push(join(packaged, 'session-index', fileName))
  }
  // The CLI compiles to CommonJS, so __dirname is the reliable anchor here:
  // out/cli/ -> repo root, plus one level deeper for a nested build layout.
  candidates.push(join(__dirname, '..', '..', 'resources', 'session-index', fileName))
  candidates.push(join(__dirname, '..', '..', '..', 'resources', 'session-index', fileName))
  return [...new Set(candidates)]
}

export type SessionIndexResolution =
  | { status: 'found'; path: string }
  | { status: 'missing'; searched: string[] }

/** Split from the lookup so both branches are testable without a real install. */
export function selectExistingSessionIndex(
  searched: readonly string[],
  exists: (candidate: string) => boolean = existsSync
): SessionIndexResolution {
  const found = searched.find((candidate) => exists(candidate))
  return found ? { status: 'found', path: found } : { status: 'missing', searched: [...searched] }
}

export function resolveSessionIndexSidecar(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string
): SessionIndexResolution {
  return selectExistingSessionIndex(getSessionIndexCandidates(env, resourcesPath))
}

/** ADR-0002: a missing sidecar degrades this capability, never the product. */
export function describeMissingSessionIndex(searched: readonly string[]): string {
  return [
    'Session search is unavailable: the session-index sidecar was not found in this install.',
    'Orca still works; only cross-tool session search and listing are affected.',
    // Not "override": the env var is tried first, not exclusively — same as the
    // delegate sidecar. Saying otherwise sends people hunting for why a pin
    // "did not take" when the install copy was found instead.
    `Set ${SESSION_INDEX_SIDECAR_PATH_ENV} to a ${sessionIndexFileName()} build to search it first.`,
    'Searched:',
    ...searched.map((candidate) => `  ${candidate}`)
  ].join('\n')
}
