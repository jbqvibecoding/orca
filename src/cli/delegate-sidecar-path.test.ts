import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DELEGATE_SIDECAR_FILE_NAME,
  DELEGATE_SIDECAR_PATH_ENV,
  describeMissingSidecar,
  getDelegateSidecarCandidates,
  resolveDelegateSidecar,
  selectExistingSidecar
} from './delegate-sidecar-path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-delegate-sidecar-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('getDelegateSidecarCandidates', () => {
  it('checks the explicit override first', () => {
    const candidates = getDelegateSidecarCandidates({ [DELEGATE_SIDECAR_PATH_ENV]: '/custom.mjs' })
    expect(candidates[0]).toBe('/custom.mjs')
  })

  it('includes the packaged resources location', () => {
    const candidates = getDelegateSidecarCandidates({}, '/Applications/Orca.app/Contents/Resources')
    expect(candidates).toContain(
      join('/Applications/Orca.app/Contents/Resources', 'delegate', DELEGATE_SIDECAR_FILE_NAME)
    )
  })

  it('always includes a repo-relative candidate', () => {
    const candidates = getDelegateSidecarCandidates({})
    expect(
      candidates.some((candidate) =>
        candidate.endsWith(join('resources', 'delegate', DELEGATE_SIDECAR_FILE_NAME))
      )
    ).toBe(true)
  })

  it('does not repeat a candidate', () => {
    const candidates = getDelegateSidecarCandidates({})
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('resolveDelegateSidecar', () => {
  it('finds the bundle through the override', () => {
    const path = join(dir, DELEGATE_SIDECAR_FILE_NAME)
    writeFileSync(path, '#!/usr/bin/env node\n', 'utf-8')
    const resolution = resolveDelegateSidecar({ [DELEGATE_SIDECAR_PATH_ENV]: path })
    expect(resolution).toEqual({ status: 'found', path })
  })

  // Proves the repo-relative candidate really resolves in a checkout: the
  // override points at nothing, so only the vendored copy can satisfy this.
  it('falls through a dead override to the vendored copy in a checkout', () => {
    const resolution = resolveDelegateSidecar({
      [DELEGATE_SIDECAR_PATH_ENV]: join(dir, 'absent.mjs')
    })
    expect(resolution.status).toBe('found')
    expect(resolution.status === 'found' && resolution.path).toContain(
      join('resources', 'delegate', DELEGATE_SIDECAR_FILE_NAME)
    )
  })
})

describe('selectExistingSidecar', () => {
  it('returns the first candidate that exists', () => {
    const resolution = selectExistingSidecar(
      ['/a.mjs', '/b.mjs', '/c.mjs'],
      (candidate) => candidate !== '/a.mjs'
    )
    expect(resolution).toEqual({ status: 'found', path: '/b.mjs' })
  })

  it('reports every path it searched when none exists', () => {
    const resolution = selectExistingSidecar(['/a.mjs', '/b.mjs'], () => false)
    expect(resolution).toEqual({ status: 'missing', searched: ['/a.mjs', '/b.mjs'] })
  })
})

describe('describeMissingSidecar', () => {
  // ADR-0002: a missing sidecar degrades the capability, and says how to fix it.
  it('names the override variable and lists what was searched', () => {
    const message = describeMissingSidecar(['/a/one.mjs', '/b/two.mjs'])
    expect(message).toContain('Delegation is unavailable')
    expect(message).toContain(DELEGATE_SIDECAR_PATH_ENV)
    expect(message).toContain('/a/one.mjs')
    expect(message).toContain('/b/two.mjs')
  })
})
