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

const gateFixture = (overrides: Record<string, unknown> = {}) =>
  okFixture('1', {
    gate: {
      cwd: '/tmp/app',
      hostId: 'local',
      verdict: 'passed',
      startedAt: 0,
      completedAt: 120,
      checks: [
        {
          check: 'test',
          verdict: 'passed',
          command: 'pnpm run test',
          exitCode: 0,
          timedOut: false,
          durationMs: 120,
          reason: null,
          stdoutTail: '',
          stderrTail: ''
        }
      ],
      ...overrides
    }
  })

describe('orca acceptance cli', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('defaults cwd to the working directory and sends no check filter', async () => {
    queueFixtures(callMock, gateFixture())
    await main(['acceptance', 'run'])
    expect(callMock).toHaveBeenCalledWith('acceptance.run', {
      cwd: process.cwd(),
      hostId: undefined,
      checks: undefined,
      timeoutSeconds: undefined
    })
  })

  it('passes repeated --check flags through as a list', async () => {
    queueFixtures(callMock, gateFixture())
    await main(['acceptance', 'run', '--check', 'test', '--check', 'lint'])
    expect(callMock.mock.calls[0][1]).toMatchObject({ checks: ['test', 'lint'] })
  })

  it('forwards an explicit host and workspace directory', async () => {
    queueFixtures(callMock, gateFixture())
    await main(['acceptance', 'run', '--cwd', '/tmp/app', '--host', 'ssh:build-box'])
    expect(callMock.mock.calls[0][1]).toMatchObject({
      cwd: '/tmp/app',
      hostId: 'ssh:build-box'
    })
  })

  // The allowlist is the feature; a caller must not be able to name its own command.
  it('rejects a check name outside the allowlist before calling the runtime', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['acceptance', 'run', '--check', 'deploy'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('deploy')
    errorSpy.mockRestore()
  })

  // A valueless --check parses as `true`; silently running all three would be
  // the opposite of what the caller asked for.
  it('refuses a valueless --check instead of widening the run', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['acceptance', 'run', '--check'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('--check requires a value')
    errorSpy.mockRestore()
  })

  it('refuses a valueless --cwd rather than falling back to the current directory', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main(['acceptance', 'run', '--cwd'])
    expect(exitCode).not.toBe(0)
    expect(callMock).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('prints the roll-up verdict and each check', async () => {
    queueFixtures(callMock, gateFixture())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['acceptance', 'run'])
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('PASSED')
    expect(output).toContain('test: passed (pnpm run test)')
    logSpy.mockRestore()
  })

  it('reads the event log with an explicit limit', async () => {
    queueFixtures(callMock, okFixture('1', { events: [], count: 0 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['acceptance', 'log', '--limit', '10'])
    expect(callMock).toHaveBeenCalledWith('acceptance.log', { limit: 10 })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('No acceptance-gate events')
    logSpy.mockRestore()
  })
})
