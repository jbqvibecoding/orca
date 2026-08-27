import { describe, expect, it } from 'vitest'
import { buildDelegateTaskSpec } from './delegate-task-spec'

const briefing = 'TypeScript monorepo built with pnpm; tests run with pnpm test.'
const objective = 'Why does the lock test deadlock under load? Stack trace attached below.'

describe('buildDelegateTaskSpec', () => {
  it('builds a read-only auto-backend task by default', () => {
    const built = buildDelegateTaskSpec({ briefing, objective })
    expect(built.ok).toBe(true)
    expect(built.ok && built.spec).toMatchObject({
      backend: 'auto',
      mode: 'read-only',
      strict: false,
      files: [],
      task: { briefing, objective }
    })
  })

  it('omits optional fields rather than sending empty strings', () => {
    const built = buildDelegateTaskSpec({ briefing, objective })
    expect(built.ok && Object.keys(built.spec.task)).toEqual(['briefing', 'objective'])
    expect(built.ok && 'model' in built.spec).toBe(false)
    expect(built.ok && 'thread' in built.spec).toBe(false)
  })

  it('carries the optional fields when given', () => {
    const built = buildDelegateTaskSpec({
      briefing,
      objective,
      locations: 'src/core/lock.ts',
      constraints: 'Do not change the public API.',
      outputContract: 'Findings ordered by severity.',
      backend: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      files: ['src/**/*.ts'],
      label: 'lock review',
      thread: 't-1',
      cwd: '/tmp/app'
    })
    expect(built.ok && built.spec).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      label: 'lock review',
      thread: 't-1',
      cwd: '/tmp/app',
      files: ['src/**/*.ts'],
      task: {
        locations: 'src/core/lock.ts',
        constraints: 'Do not change the public API.',
        output_contract: 'Findings ordered by severity.'
      }
    })
  })

  // Refusing in English before spawning beats the sidecar's Chinese schema error.
  it('refuses a briefing too thin to brief a model with no project knowledge', () => {
    const built = buildDelegateTaskSpec({ briefing: 'a repo', objective })
    expect(built.ok).toBe(false)
    expect(!built.ok && built.error).toContain('--briefing needs at least 20 characters')
  })

  it('refuses a thin objective', () => {
    const built = buildDelegateTaskSpec({ briefing, objective: 'why slow' })
    expect(!built.ok && built.error).toContain('--objective needs at least 20 characters')
  })

  it('trims before measuring, so whitespace cannot pad a thin field', () => {
    const built = buildDelegateTaskSpec({ briefing: `${'  '.repeat(20)}short`, objective })
    expect(built.ok).toBe(false)
  })

  it('rejects an unknown backend and names the allowed set', () => {
    const built = buildDelegateTaskSpec({ briefing, objective, backend: 'gemini' })
    expect(!built.ok && built.error).toContain('auto, claude, codex, grok, kimi, agy')
  })

  it('rejects an unknown mode and effort', () => {
    expect(buildDelegateTaskSpec({ briefing, objective, mode: 'write' }).ok).toBe(false)
    expect(buildDelegateTaskSpec({ briefing, objective, effort: 'max' }).ok).toBe(false)
  })

  // strict is the isolation guarantee: only the whitelist physically exists.
  it('refuses --strict without a file whitelist', () => {
    const built = buildDelegateTaskSpec({ briefing, objective, strict: true })
    expect(!built.ok && built.error).toContain('--files is required')
  })

  it('refuses --strict on an edit task, which needs the real workspace', () => {
    const built = buildDelegateTaskSpec({
      briefing,
      objective,
      strict: true,
      mode: 'edit',
      files: ['src/**']
    })
    expect(!built.ok && built.error).toContain('read-only')
  })

  it('accepts strict with a whitelist', () => {
    const built = buildDelegateTaskSpec({
      briefing,
      objective,
      strict: true,
      files: ['src/core/lock.ts']
    })
    expect(built.ok && built.spec.strict).toBe(true)
  })
})
