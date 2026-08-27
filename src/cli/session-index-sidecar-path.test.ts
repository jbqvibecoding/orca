import { describe, expect, it } from 'vitest'
import {
  describeMissingSessionIndex,
  getSessionIndexCandidates,
  selectExistingSessionIndex,
  sessionIndexFileName,
  SESSION_INDEX_SIDECAR_PATH_ENV
} from './session-index-sidecar-path'

describe('session index sidecar lookup', () => {
  it('carries the executable suffix Windows needs', () => {
    expect(sessionIndexFileName('linux')).toBe('wake-index')
    expect(sessionIndexFileName('darwin')).toBe('wake-index')
    expect(sessionIndexFileName('win32')).toBe('wake-index.exe')
  })

  it('tries the override first, then the packaged install, then the checkout', () => {
    const candidates = getSessionIndexCandidates(
      { [SESSION_INDEX_SIDECAR_PATH_ENV]: '/pinned/wake-index' },
      '/Applications/Orca.app/Contents/Resources',
      'linux'
    )
    expect(candidates[0]).toBe('/pinned/wake-index')
    expect(candidates[1]).toBe('/Applications/Orca.app/Contents/Resources/session-index/wake-index')
    expect(candidates.length).toBeGreaterThan(2)
  })

  it('does not search the packaged path when there is no packaged install', () => {
    const candidates = getSessionIndexCandidates({}, undefined, 'linux')
    expect(candidates.some((candidate) => candidate.includes('Resources'))).toBe(false)
  })

  it('picks the first candidate that exists', () => {
    const resolution = selectExistingSessionIndex(['/a', '/b', '/c'], (path) => path !== '/a')
    expect(resolution).toEqual({ status: 'found', path: '/b' })
  })

  // ADR-0002: the capability degrades, the product does not. The message has to
  // say what still works and how to point Orca at a build.
  it('explains an absent sidecar without implying Orca is broken', () => {
    const resolution = selectExistingSessionIndex(['/a', '/b'], () => false)
    expect(resolution.status).toBe('missing')
    const message = describeMissingSessionIndex(
      resolution.status === 'missing' ? resolution.searched : []
    )
    expect(message).toContain('Orca still works')
    expect(message).toContain(SESSION_INDEX_SIDECAR_PATH_ENV)
    expect(message).toContain('/a')
    expect(message).toContain('/b')
  })
})
