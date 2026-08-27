// The one process that commits agent memory.
//
// This is the load-bearing rule of ADR-0008, and it is not a style preference:
// git's index lock is process-global, so N agents committing concurrently in one
// repository corrupt each other's `.git/index.lock`. Agents write plain files;
// only this queue commits them.
//
// A queue, not a commit call. Commits are serialised through one promise chain
// and retried with backoff, because the failure this prevents is precisely two
// commits overlapping.

import { mkdir } from 'node:fs/promises'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'

/** Author on the audit commits. Not a real person, and should not look like one. */
const AUDIT_AUTHOR = 'Orca <orca@localhost>'

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 50

export type MemoryCommitOutcome =
  | { status: 'committed'; attempts: number }
  | { status: 'nothing-to-commit' }
  // Git absent is a first-class outcome, not a failure: memory still works, it
  // just has no audit trail. ADR-0008 requires that degradation because not
  // every workspace is a git repo.
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string; attempts: number }

export type GitRunner = (
  args: readonly string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const result = await gitExecFileAsync([...args], { cwd })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function ensureRepository(root: string, run: GitRunner): Promise<void> {
  await mkdir(root, { recursive: true })
  try {
    await run(['rev-parse', '--git-dir'], root)
    return
  } catch {
    // Not a repository yet — the first commit creates it.
  }
  await run(['init', '--quiet'], root)
}

async function hasStagedChanges(root: string, run: GitRunner): Promise<boolean> {
  const status = await run(['status', '--porcelain'], root)
  return status.stdout.trim().length > 0
}

async function commitOnce(args: {
  root: string
  message: string
  run: GitRunner
}): Promise<'committed' | 'nothing-to-commit'> {
  await args.run(['add', '--all'], args.root)
  if (!(await hasStagedChanges(args.root, args.run))) {
    return 'nothing-to-commit'
  }
  await args.run(
    // `-c` before the subcommand so the identity applies without writing it into
    // the user's global git config.
    [
      '-c',
      `user.name=${AUDIT_AUTHOR.split(' <')[0]}`,
      '-c',
      `user.email=${AUDIT_AUTHOR.replace(/^.*</, '').replace(/>$/, '')}`,
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '--message',
      args.message
    ],
    args.root
  )
  return 'committed'
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Serialises every commit for one audit repository. Construct one per root and
 * keep it: two queues over the same directory would reintroduce exactly the
 * concurrency this exists to prevent.
 */
export class AgentMemoryCommitQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly run: GitRunner

  constructor(
    private readonly root: string,
    run: GitRunner = defaultGitRunner
  ) {
    this.run = run
  }

  /** Resolves when this commit has settled; never rejects, so a failed audit write cannot break the caller. */
  enqueue(message: string): Promise<MemoryCommitOutcome> {
    const next = this.chain.then(() => this.commitWithRetries(message))
    // The chain must survive a rejection, or one failure would wedge the queue.
    this.chain = next.catch(() => undefined)
    return next
  }

  private async commitWithRetries(message: string): Promise<MemoryCommitOutcome> {
    let lastError = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await ensureRepository(this.root, this.run).then(() =>
          commitOnce({ root: this.root, message, run: this.run })
        )
        return result === 'committed'
          ? { status: 'committed', attempts: attempt }
          : { status: 'nothing-to-commit' }
      } catch (error) {
        lastError = describe(error)
        if (isGitMissing(lastError)) {
          return { status: 'unavailable', reason: lastError }
        }
        if (attempt < MAX_ATTEMPTS) {
          await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1))
        }
      }
    }
    return { status: 'failed', reason: lastError, attempts: MAX_ATTEMPTS }
  }
}

/** No git binary at all is a different thing from a commit that went wrong. */
export function isGitMissing(reason: string): boolean {
  return /ENOENT|not found|is not recognized/i.test(reason)
}
