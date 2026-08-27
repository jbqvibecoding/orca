// Locates the vendored delegation sidecar across the layouts it can ship in.
//
// Same candidate-list shape as getLocalRelayCandidates() in
// src/main/ssh/ssh-relay-deploy.ts, minus Electron's `app`: this runs in the
// CLI process, which has no app.getAppPath(). The bundle ships as an
// extraResource rather than inside app.asar because Node cannot execute a file
// from an asar archive.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DELEGATE_SIDECAR_FILE_NAME = 'ywcrew-standalone.mjs'
export const DELEGATE_SIDECAR_PATH_ENV = 'ORCA_DELEGATE_SIDECAR_PATH'

/** Electron augments `process` with this; the CLI's type surface does not. */
function packagedResourcesPath(override: string | undefined): string | undefined {
  if (override !== undefined) {
    return override
  }
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

export function getDelegateSidecarCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string
): string[] {
  const candidates: string[] = []
  const override = env[DELEGATE_SIDECAR_PATH_ENV]
  if (override) {
    candidates.push(override)
  }
  const packaged = packagedResourcesPath(resourcesPath)
  if (packaged) {
    candidates.push(join(packaged, 'delegate', DELEGATE_SIDECAR_FILE_NAME))
  }
  // The CLI compiles to CommonJS, so __dirname is the reliable anchor here:
  // out/cli/ -> repo root, plus one level deeper for a nested build layout.
  candidates.push(join(__dirname, '..', '..', 'resources', 'delegate', DELEGATE_SIDECAR_FILE_NAME))
  candidates.push(
    join(__dirname, '..', '..', '..', 'resources', 'delegate', DELEGATE_SIDECAR_FILE_NAME)
  )
  return [...new Set(candidates)]
}

export type DelegateSidecarResolution =
  | { status: 'found'; path: string }
  | { status: 'missing'; searched: string[] }

/** Split from the lookup so both branches are testable without a real install. */
export function selectExistingSidecar(
  searched: readonly string[],
  exists: (candidate: string) => boolean = existsSync
): DelegateSidecarResolution {
  const found = searched.find((candidate) => exists(candidate))
  return found ? { status: 'found', path: found } : { status: 'missing', searched: [...searched] }
}

export function resolveDelegateSidecar(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string
): DelegateSidecarResolution {
  return selectExistingSidecar(getDelegateSidecarCandidates(env, resourcesPath))
}

/** ADR-0002: a missing sidecar degrades this capability, never the product. */
export function describeMissingSidecar(searched: readonly string[]): string {
  return [
    'Delegation is unavailable: the delegate sidecar was not found in this install.',
    `Set ${DELEGATE_SIDECAR_PATH_ENV} to a ${DELEGATE_SIDECAR_FILE_NAME} build to override the search.`,
    'Searched:',
    ...searched.map((candidate) => `  ${candidate}`)
  ].join('\n')
}
