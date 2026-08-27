// Which package manager a workspace uses, and the commands to drive it.
//
// Extracted from setup-script-package-manager-suggestion.ts so the acceptance
// gate resolves `pnpm run test` vs `npm run test` from the same table and the
// same precedence the setup-script suggestion already uses. Two consumers with
// two lockfile tables would disagree the first time a manager is added.

export type PackageManagerName = 'pnpm' | 'bun' | 'yarn' | 'npm'

export type PackageManagerLockfile = {
  readonly path: string
  readonly manager: PackageManagerName
}

// Order matters: it decides which lockfile is reported when a workspace has
// several that agree on the manager (bun ships two lockfile formats).
export const PACKAGE_MANAGER_LOCKFILES: readonly PackageManagerLockfile[] = [
  { path: 'pnpm-lock.yaml', manager: 'pnpm' },
  { path: 'bun.lock', manager: 'bun' },
  { path: 'bun.lockb', manager: 'bun' },
  { path: 'yarn.lock', manager: 'yarn' },
  { path: 'package-lock.json', manager: 'npm' },
  { path: 'npm-shrinkwrap.json', manager: 'npm' }
]

export const DEFAULT_PACKAGE_MANAGER: PackageManagerName = 'npm'

/** Reads npm's `packageManager` field (`pnpm@9.0.0`), which outranks lockfiles. */
export function parsePackageManagerField(value: unknown): PackageManagerName | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  for (const manager of ['pnpm', 'bun', 'yarn', 'npm'] as const) {
    if (normalized.startsWith(`${manager}@`)) {
      return manager
    }
  }
  return null
}

export type LockfileSelection =
  | { readonly ok: true; readonly lockfile: PackageManagerLockfile | null }
  // Why: several managers' lockfiles in one workspace is a real repo mistake;
  // guessing one would run the wrong binary, so callers must handle it.
  | { readonly ok: false; readonly managers: readonly PackageManagerName[] }

export function selectPackageManagerLockfile(presentPaths: readonly string[]): LockfileSelection {
  const present = new Set(presentPaths)
  const matches = PACKAGE_MANAGER_LOCKFILES.filter((entry) => present.has(entry.path))
  const managers = [...new Set(matches.map((entry) => entry.manager))]
  if (managers.length > 1) {
    return { ok: false, managers }
  }
  return { ok: true, lockfile: matches[0] ?? null }
}

export function buildPackageManagerInstallCommand(manager: PackageManagerName): string {
  return `${manager} install`
}

export function buildPackageManagerRunCommand(manager: PackageManagerName, script: string): string {
  return `${manager} run ${script}`
}
