// Runs the vendored delegation sidecar as a child process.
//
// Delegation is always local, even when this CLI is paired to a remote Orca
// server: the sidecar drives the vendor CLIs installed and logged in on this
// machine, and keeps its runs under this machine's home directory.

import { runProcess } from '../shared/child-process/run-process'

export const DELEGATE_HOME_ENV = 'YWCREW_HOME'

/** The sidecar reports "still running" this way; it is not a failure. */
export const DELEGATE_PENDING_EXIT_CODE = 3

export type DelegateSidecarOutcome =
  | { status: 'ok'; stdout: string }
  | { status: 'pending'; stdout: string }
  | { status: 'failed'; message: string }

export type DelegateSidecarRunner = (args: {
  sidecarPath: string
  argv: readonly string[]
  input?: string
  timeoutMs?: number | null
  home?: string
}) => Promise<DelegateSidecarOutcome>

function sidecarEnv(home: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // process.execPath is Electron in a packaged host; without this it would
    // boot the app instead of running the bundle as a script.
    ELECTRON_RUN_AS_NODE: '1',
    ...(home ? { [DELEGATE_HOME_ENV]: home } : {})
  }
}

export const runDelegateSidecar: DelegateSidecarRunner = async ({
  sidecarPath,
  argv,
  input,
  timeoutMs,
  home
}) => {
  const result = await runProcess({
    program: process.execPath,
    args: [sidecarPath, ...argv],
    env: sidecarEnv(home),
    input,
    timeoutMs: timeoutMs ?? null
  })
  if (result.timedOut) {
    return { status: 'failed', message: `The delegate sidecar timed out running: ${argv[0]}` }
  }
  if (result.code === 0) {
    return { status: 'ok', stdout: result.stdout }
  }
  if (result.code === DELEGATE_PENDING_EXIT_CODE) {
    return { status: 'pending', stdout: result.stdout }
  }
  const message = result.stderr.trim() || result.stdout.trim()
  return { status: 'failed', message: message || `The delegate sidecar exited ${result.code}.` }
}

export function parseSidecarJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return null
  }
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // The sidecar prints human text on some paths (doctor, backends).
    return null
  }
}
