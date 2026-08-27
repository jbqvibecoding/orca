import { describe, expect, it } from 'vitest'
import {
  buildPackageManagerInstallCommand,
  buildPackageManagerRunCommand,
  parsePackageManagerField,
  selectPackageManagerLockfile
} from './package-manager-detection'

describe('parsePackageManagerField', () => {
  it('reads the manager out of a pinned spec', () => {
    expect(parsePackageManagerField('pnpm@10.24.0')).toBe('pnpm')
    expect(parsePackageManagerField('  YARN@4.1.0 ')).toBe('yarn')
    expect(parsePackageManagerField('bun@1.1.0')).toBe('bun')
    expect(parsePackageManagerField('npm@10.0.0')).toBe('npm')
  })

  it('rejects anything without a version pin or an unknown manager', () => {
    expect(parsePackageManagerField('pnpm')).toBeNull()
    expect(parsePackageManagerField('deno@2')).toBeNull()
    expect(parsePackageManagerField(42)).toBeNull()
    expect(parsePackageManagerField(undefined)).toBeNull()
  })
})

describe('selectPackageManagerLockfile', () => {
  it('returns no lockfile when none are present', () => {
    const selection = selectPackageManagerLockfile([])
    expect(selection).toEqual({ ok: true, lockfile: null })
  })

  it('selects the single matching manager', () => {
    const selection = selectPackageManagerLockfile(['pnpm-lock.yaml'])
    expect(selection.ok && selection.lockfile?.manager).toBe('pnpm')
  })

  // Bun ships two lockfile formats; both mean bun, so this is not ambiguous.
  it('treats two lockfiles for the same manager as unambiguous', () => {
    const selection = selectPackageManagerLockfile(['bun.lock', 'bun.lockb'])
    expect(selection.ok && selection.lockfile?.manager).toBe('bun')
    expect(selection.ok && selection.lockfile?.path).toBe('bun.lock')
  })

  it('refuses to guess when two managers claim the workspace', () => {
    const selection = selectPackageManagerLockfile(['pnpm-lock.yaml', 'package-lock.json'])
    expect(selection.ok).toBe(false)
    expect(!selection.ok && [...selection.managers].sort()).toEqual(['npm', 'pnpm'])
  })

  it('ignores unrelated files', () => {
    const selection = selectPackageManagerLockfile(['Cargo.lock', 'poetry.lock'])
    expect(selection).toEqual({ ok: true, lockfile: null })
  })
})

describe('command builders', () => {
  it('builds install and run commands per manager', () => {
    expect(buildPackageManagerInstallCommand('pnpm')).toBe('pnpm install')
    expect(buildPackageManagerRunCommand('npm', 'test')).toBe('npm run test')
    expect(buildPackageManagerRunCommand('yarn', 'typecheck')).toBe('yarn run typecheck')
  })
})
