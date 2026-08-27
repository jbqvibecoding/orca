// Runs the session-index sidecar as a child process.
//
// Always local, even when this CLI is paired to a remote Orca server. The index
// describes agent sessions found under *this* machine's home directory, so
// routing the query through a remote runtime would answer about the wrong
// machine — which is why there is no RPC path for it.

import { runProcess } from '../shared/child-process/run-process'

/** A query holds a SQLite read; the sidecar has no long-running mode. */
const DEFAULT_TIMEOUT_MS = 30_000
/** A full rescan walks every agent's history and is the one slow subcommand. */
export const SESSION_INDEX_SCAN_TIMEOUT_MS = 10 * 60_000

export type SessionIndexOutcome =
  | { status: 'ok'; stdout: string }
  | { status: 'failed'; message: string }

export type SessionIndexRunner = (args: {
  sidecarPath: string
  argv: readonly string[]
  timeoutMs?: number | null
}) => Promise<SessionIndexOutcome>

export const runSessionIndexSidecar: SessionIndexRunner = async ({
  sidecarPath,
  argv,
  timeoutMs
}) => {
  let result
  try {
    result = await runProcess({
      program: sidecarPath,
      args: [...argv],
      timeoutMs: timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs
    })
  } catch (error) {
    // A path that resolved but cannot be executed — deleted since the lookup,
    // not marked executable, built for another architecture — arrives here as a
    // spawn rejection. It is the same "this install has no working sidecar"
    // situation as a missing file, so it degrades rather than crashing the CLI.
    return {
      status: 'failed',
      message: `The session index at ${sidecarPath} could not be run: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
  if (result.timedOut) {
    return { status: 'failed', message: `The session index timed out running: ${argv[0]}` }
  }
  if (result.code === 0) {
    return { status: 'ok', stdout: result.stdout }
  }
  // The sidecar keeps stdout for valid JSON and puts every diagnostic on stderr,
  // so its own message is the useful one whenever there is one.
  const message = result.stderr.trim()
  return { status: 'failed', message: message || `The session index exited ${result.code}.` }
}

export class SessionIndexOutputError extends Error {}

/** Unlike the delegate sidecar, every subcommand here prints JSON — non-JSON is a fault. */
export function parseSessionIndexJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new SessionIndexOutputError('The session index produced no output.')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new SessionIndexOutputError(
      `The session index produced output that is not JSON: ${trimmed.slice(0, 200)}`
    )
  }
}
