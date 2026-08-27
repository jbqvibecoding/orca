import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const listFixture = () =>
  okFixture('1', {
    workflows: [
      { name: 'standard', origin: 'builtin', description: 'Research, plan, execute.', error: null },
      { name: 'broken', origin: 'project', description: null, error: 'declares no phases' }
    ]
  })

const statusFixture = (overrides: Record<string, unknown> = {}) =>
  okFixture('1', {
    status: {
      taskId: 'task_abc',
      workflow: 'standard',
      origin: 'builtin',
      phase: 'planning',
      cycle: 0,
      enteredAt: '2026-08-27 10:00:00',
      artifact: '.orca/plan.md',
      artifactStatus: 'absent',
      accepts: ['typecheck'],
      lastRefusal: null,
      ...overrides
    }
  })

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().join('\n')
}

describe('orca workflow cli', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('lists workflows with their origin, defaulting cwd to the working directory', async () => {
    queueFixtures(callMock, listFixture())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'list'])
    expect(callMock).toHaveBeenCalledWith('workflow.list', {
      cwd: process.cwd(),
      hostId: undefined
    })
    expect(output(logSpy)).toContain('standard')
    expect(output(logSpy)).toContain('builtin')
    logSpy.mockRestore()
  })

  // Hiding a document that no longer parses would make a broken file look like
  // a missing one.
  it('shows a broken document in the listing rather than dropping it', async () => {
    queueFixtures(callMock, listFixture())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'list'])
    expect(output(logSpy)).toContain('BROKEN — declares no phases')
    logSpy.mockRestore()
  })

  it('forwards an explicit host and workspace directory', async () => {
    queueFixtures(callMock, listFixture())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'list', '--cwd', '/tmp/app', '--host', 'ssh:build-box'])
    expect(callMock.mock.calls[0][1]).toMatchObject({
      cwd: '/tmp/app',
      hostId: 'ssh:build-box'
    })
    logSpy.mockRestore()
  })

  it('renders a phase chain with its gates and artifacts', async () => {
    queueFixtures(
      callMock,
      okFixture('1', {
        name: 'standard',
        origin: 'builtin',
        description: 'Research, plan, execute.',
        cycleTo: 'planning',
        unknownKeys: ['future'],
        phases: [
          {
            phase: 'planning',
            artifact: '.orca/plan.md',
            accepts: [],
            gate: { kind: 'entry' },
            hasInstruction: true
          },
          {
            phase: 'running',
            artifact: '.orca/execute.md',
            accepts: ['typecheck', 'test'],
            gate: {
              kind: 'requires-predecessor',
              predecessor: 'planning',
              artifact: '.orca/plan.md'
            },
            hasInstruction: true
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'show', '--workflow', 'standard'])
    expect(callMock.mock.calls[0][1]).toMatchObject({ name: 'standard' })
    const text = output(logSpy)
    expect(text).toContain('can start here')
    expect(text).toContain('waits for planning to write .orca/plan.md')
    expect(text).toContain('returns to planning')
    expect(text).toContain('future')
    logSpy.mockRestore()
  })

  it('starts a task on a workflow', async () => {
    queueFixtures(
      callMock,
      okFixture('1', { taskId: 'task_abc', workflow: 'standard', phase: 'research' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'start', '--task', 'task_abc', '--workflow', 'standard'])
    expect(callMock).toHaveBeenCalledWith('workflow.start', {
      cwd: process.cwd(),
      hostId: undefined,
      taskId: 'task_abc',
      name: 'standard'
    })
    expect(output(logSpy)).toContain('starting at research')
    logSpy.mockRestore()
  })

  it('reports the phase, its artifact, and whether the artifact is there', async () => {
    queueFixtures(callMock, statusFixture())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'status', '--task', 'task_abc'])
    const text = output(logSpy)
    expect(text).toContain('phase planning')
    expect(text).toContain('.orca/plan.md — not written yet')
    logSpy.mockRestore()
  })

  // "could not be checked" and "not written yet" are different facts.
  it('distinguishes an unreachable artifact from a missing one', async () => {
    queueFixtures(callMock, statusFixture({ artifactStatus: 'unreachable' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'status', '--task', 'task_abc'])
    expect(output(logSpy)).toContain('could not be checked')
    logSpy.mockRestore()
  })

  it('reports the last refusal when one is recorded', async () => {
    queueFixtures(
      callMock,
      statusFixture({
        lastRefusal: { cause: 'acceptance-failed', reason: 'The acceptance gate (test) failed.' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'status', '--task', 'task_abc'])
    expect(output(logSpy)).toContain('last refused (acceptance-failed)')
    logSpy.mockRestore()
  })

  it('advances a task and names the phase it moved to', async () => {
    queueFixtures(
      callMock,
      okFixture('1', { decision: { kind: 'advance', from: 'planning', to: 'running', cycle: 0 } })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'advance', '--task', 'task_abc'])
    expect(callMock.mock.calls[0][1]).toMatchObject({
      taskId: 'task_abc',
      waiveAcceptance: false
    })
    expect(output(logSpy)).toContain('Advanced from planning to running')
    logSpy.mockRestore()
  })

  it('reports a refusal with its reason instead of claiming progress', async () => {
    queueFixtures(
      callMock,
      okFixture('1', {
        decision: {
          kind: 'refused',
          cause: 'artifact-missing',
          reason: '.orca/plan.md has not been written yet, so this phase is not finished.'
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'advance', '--task', 'task_abc'])
    expect(output(logSpy)).toContain('Did not advance (artifact-missing)')
    logSpy.mockRestore()
  })

  it('names the pass number when a cyclic workflow loops', async () => {
    queueFixtures(
      callMock,
      okFixture('1', { decision: { kind: 'advance', from: 'review', to: 'planning', cycle: 1 } })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'advance', '--task', 'task_abc'])
    expect(output(logSpy)).toContain('(pass 2)')
    logSpy.mockRestore()
  })

  it('passes the acceptance waiver through explicitly', async () => {
    queueFixtures(
      callMock,
      okFixture('1', { decision: { kind: 'finished', from: 'review', cycle: 0 } })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['workflow', 'advance', '--task', 'task_abc', '--waive-acceptance'])
    expect(callMock.mock.calls[0][1]).toMatchObject({ waiveAcceptance: true })
    logSpy.mockRestore()
  })

  // A valueless flag parses as `true`, which the optional readers treat as absent.
  it('refuses a valueless --cwd rather than falling back to the current directory', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['workflow', 'list', '--cwd'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    expect(output(errorSpy)).toContain('--cwd requires a value')
    errorSpy.mockRestore()
  })

  it('refuses a valueless --workflow', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['workflow', 'show', '--workflow'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('requires a task id to advance', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['workflow', 'advance'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
