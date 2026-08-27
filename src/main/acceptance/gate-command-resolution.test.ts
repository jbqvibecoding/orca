import { describe, expect, it } from 'vitest'
import { resolveCheckCommand } from './gate-command-resolution'

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest run', lint: 'oxlint' }, ...extra })

describe('resolveCheckCommand', () => {
  it('resolves through the lockfile-detected manager', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: manifest(),
      presentLockfilePaths: ['pnpm-lock.yaml']
    })
    expect(resolution).toMatchObject({
      status: 'resolved',
      command: 'pnpm run test',
      manager: 'pnpm'
    })
  })

  it('lets the packageManager field outrank the lockfile', () => {
    const resolution = resolveCheckCommand({
      check: 'lint',
      packageJson: manifest({ packageManager: 'yarn@4.1.0' }),
      presentLockfilePaths: ['package-lock.json']
    })
    expect(resolution).toMatchObject({ status: 'resolved', command: 'yarn run lint' })
  })

  it('falls back to npm when nothing declares a manager', () => {
    const resolution = resolveCheckCommand({
      check: 'typecheck',
      packageJson: manifest(),
      presentLockfilePaths: []
    })
    expect(resolution).toMatchObject({ status: 'resolved', command: 'npm run typecheck' })
  })

  it('skips when the workspace has no package.json', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: null,
      presentLockfilePaths: []
    })
    expect(resolution).toEqual({ status: 'skipped', reason: 'workspace has no package.json' })
  })

  it('skips when the requested script is absent', () => {
    const resolution = resolveCheckCommand({
      check: 'lint',
      packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
      presentLockfilePaths: []
    })
    expect(resolution).toMatchObject({ status: 'skipped' })
    expect(resolution.status === 'skipped' && resolution.reason).toContain('no "lint" script')
  })

  it('skips when there are no scripts at all', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: JSON.stringify({ name: 'app' }),
      presentLockfilePaths: []
    })
    expect(resolution).toMatchObject({
      status: 'skipped',
      reason: 'package.json declares no scripts'
    })
  })

  it('skips on unparseable package.json rather than guessing', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: '{ not json',
      presentLockfilePaths: []
    })
    expect(resolution).toMatchObject({ status: 'skipped' })
  })

  // Fails closed: skipped never rolls up to passed, and the reason names the fix.
  it('skips and names both managers when lockfiles disagree', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: manifest(),
      presentLockfilePaths: ['pnpm-lock.yaml', 'yarn.lock']
    })
    expect(resolution).toMatchObject({ status: 'skipped' })
    expect(resolution.status === 'skipped' && resolution.reason).toContain(
      'cannot tell which package manager'
    )
  })

  it('ignores a non-string script entry', () => {
    const resolution = resolveCheckCommand({
      check: 'test',
      packageJson: JSON.stringify({ scripts: { test: { run: 'vitest' } } }),
      presentLockfilePaths: []
    })
    expect(resolution).toMatchObject({ status: 'skipped' })
  })
})
