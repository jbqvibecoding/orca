import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock,
  sidecarMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn(),
  sidecarMock: vi.fn()
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

vi.mock('./delegate-sidecar-run', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./delegate-sidecar-run')
  return { ...actual, runDelegateSidecar: sidecarMock }
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const BRIEFING = 'TypeScript monorepo built with pnpm; tests run with pnpm test.'
const OBJECTIVE = 'Why does the lock test deadlock under load? Stack trace attached below.'

function dispatched(runId = 'r-1'): { status: 'ok'; stdout: string } {
  return { status: 'ok', stdout: JSON.stringify({ runId, threadId: 't-1', warnings: [] }) }
}

function lastTaskDocument(): Record<string, unknown> {
  const call = sidecarMock.mock.calls.find(([args]) => args.argv[0] === 'run')
  return JSON.parse(call![0].input as string)
}

describe('orca agent delegate cli', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('builds a task document from flags and dispatches it on stdin', async () => {
    sidecarMock.mockReset().mockResolvedValue(dispatched())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'delegate', '--briefing', BRIEFING, '--objective', OBJECTIVE])

    expect(sidecarMock.mock.calls[0][0].argv).toEqual(['run', '--stdin'])
    expect(lastTaskDocument()).toMatchObject({
      backend: 'auto',
      mode: 'read-only',
      task: { briefing: BRIEFING, objective: OBJECTIVE }
    })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Delegated run r-1')
    logSpy.mockRestore()
  })

  it('passes repeated --files through as a whitelist', async () => {
    sidecarMock.mockReset().mockResolvedValue(dispatched())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([
      'agent',
      'delegate',
      '--briefing',
      BRIEFING,
      '--objective',
      OBJECTIVE,
      '--files',
      'src/**/*.ts',
      '--files',
      '!**/*.test.ts'
    ])
    expect(lastTaskDocument().files).toEqual(['src/**/*.ts', '!**/*.test.ts'])
    logSpy.mockRestore()
  })

  it('refuses a thin briefing before spawning anything', async () => {
    sidecarMock.mockReset().mockResolvedValue(dispatched())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main([
      'agent',
      'delegate',
      '--briefing',
      'short',
      '--objective',
      OBJECTIVE
    ])
    expect(exitCode).not.toBe(0)
    expect(sidecarMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('--briefing needs at least')
    errorSpy.mockRestore()
  })

  it('refuses --strict without a whitelist, because strict is the isolation', async () => {
    sidecarMock.mockReset().mockResolvedValue(dispatched())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main([
      'agent',
      'delegate',
      '--briefing',
      BRIEFING,
      '--objective',
      OBJECTIVE,
      '--strict'
    ])
    expect(exitCode).not.toBe(0)
    expect(sidecarMock).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  // The sidecar speaks Chinese; the CLI must not.
  it('translates a sidecar failure and keeps its text as detail', async () => {
    sidecarMock.mockReset().mockResolvedValue({
      status: 'failed',
      message:
        '后端 kimi 的命令 kimi 不在 PATH 中。先安装它，或换一个后端（ywcrew backends 查看）。'
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await main([
      'agent',
      'delegate',
      '--backend',
      'kimi',
      '--briefing',
      BRIEFING,
      '--objective',
      OBJECTIVE
    ])
    expect(exitCode).not.toBe(0)
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toContain('`kimi` is not on PATH')
    expect(output).toContain('detail: 后端 kimi')
    errorSpy.mockRestore()
  })

  it('waits for the result when --wait is given', async () => {
    sidecarMock
      .mockReset()
      .mockResolvedValueOnce(dispatched())
      .mockResolvedValueOnce({
        status: 'ok',
        stdout: JSON.stringify({ status: 'ok', summary: 'no deadlock' })
      })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'delegate', '--briefing', BRIEFING, '--objective', OBJECTIVE, '--wait'])
    expect(sidecarMock.mock.calls[1][0].argv).toEqual([
      'result',
      'r-1',
      '--wait',
      '--timeout',
      '600'
    ])
    expect(logSpy.mock.calls.flat().join('\n')).toContain('no deadlock')
    logSpy.mockRestore()
  })

  it('reports a still-running result rather than claiming it settled', async () => {
    sidecarMock.mockReset().mockResolvedValue({ status: 'pending', stdout: '{"pending":true}' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'delegate-show', '--run', 'r-9'])
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Still running')
    logSpy.mockRestore()
  })

  it('runs doctor through the sidecar', async () => {
    sidecarMock
      .mockReset()
      .mockResolvedValue({ status: 'ok', stdout: 'backend status:\n  claude ok' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'delegate-doctor'])
    expect(sidecarMock.mock.calls[0][0].argv).toEqual(['doctor'])
    expect(logSpy.mock.calls.flat().join('\n')).toContain('claude ok')
    logSpy.mockRestore()
  })

  it('runs setup non-interactively', async () => {
    sidecarMock.mockReset().mockResolvedValue({ status: 'ok', stdout: 'enabled: claude' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'delegate-setup'])
    expect(sidecarMock.mock.calls[0][0].argv).toEqual(['init', '--yes'])
    logSpy.mockRestore()
  })
})
