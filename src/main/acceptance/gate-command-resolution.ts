// Turns a check name into the concrete command to run, from the workspace's
// own package.json. The caller never supplies a command: an agent that can
// write the gate command can pass the gate.

import type { AcceptanceCheckName } from '../../shared/acceptance-gate'
import {
  DEFAULT_PACKAGE_MANAGER,
  PACKAGE_MANAGER_LOCKFILES,
  buildPackageManagerRunCommand,
  parsePackageManagerField,
  selectPackageManagerLockfile,
  type PackageManagerName
} from '../../shared/package-manager-detection'

export type CheckCommandResolution =
  | {
      status: 'resolved'
      command: string
      manager: PackageManagerName
      script: AcceptanceCheckName
    }
  | { status: 'skipped'; reason: string }

export const PACKAGE_MANAGER_LOCKFILE_PATHS: readonly string[] = PACKAGE_MANAGER_LOCKFILES.map(
  (entry) => entry.path
)

function parseScripts(packageJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(packageJson)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function resolveManager(
  manifest: Record<string, unknown>,
  presentLockfilePaths: readonly string[]
): { manager: PackageManagerName } | { ambiguous: readonly PackageManagerName[] } {
  const declared = parsePackageManagerField(manifest.packageManager)
  if (declared) {
    return { manager: declared }
  }
  const selection = selectPackageManagerLockfile(presentLockfilePaths)
  if (!selection.ok) {
    return { ambiguous: selection.managers }
  }
  return { manager: selection.lockfile?.manager ?? DEFAULT_PACKAGE_MANAGER }
}

export function resolveCheckCommand(args: {
  check: AcceptanceCheckName
  /** Raw package.json contents, or null when the workspace has none. */
  packageJson: string | null
  presentLockfilePaths: readonly string[]
}): CheckCommandResolution {
  if (args.packageJson === null) {
    return { status: 'skipped', reason: 'workspace has no package.json' }
  }
  const manifest = parseScripts(args.packageJson)
  if (!manifest) {
    return { status: 'skipped', reason: 'package.json is not a JSON object' }
  }
  const scripts = manifest.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return { status: 'skipped', reason: 'package.json declares no scripts' }
  }
  if (typeof (scripts as Record<string, unknown>)[args.check] !== 'string') {
    return { status: 'skipped', reason: `package.json has no "${args.check}" script` }
  }

  const resolved = resolveManager(manifest, args.presentLockfilePaths)
  if ('ambiguous' in resolved) {
    // Why skipped rather than a new verdict: the roll-up never turns skipped
    // into passed, so this fails closed while naming the repo problem to fix.
    return {
      status: 'skipped',
      reason: `workspace has lockfiles for ${resolved.ambiguous.join(' and ')}; cannot tell which package manager to use`
    }
  }
  return {
    status: 'resolved',
    command: buildPackageManagerRunCommand(resolved.manager, args.check),
    manager: resolved.manager,
    script: args.check
  }
}
