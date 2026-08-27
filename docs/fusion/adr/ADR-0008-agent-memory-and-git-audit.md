# ADR-0008 — Per-agent memory files, git as the audit layer, one committer

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** 2 (contract port); mailbox and blackboard are design-only

## Context

Orca's `src/main/memory/` is process memory metrics — RAM per PTY. There is no
agent memory in this product: an agent that is restarted, or a second agent
picking up related work, starts from nothing.

munder-difflin's `HIVE.md` is a careful design document for exactly this
problem, and its four locked decisions were reached by hitting the failure modes
first. Two of them are about correctness under concurrency, which is where naive
implementations break.

Orca, however, already has a mailbox: `orchestration send / check / reply /
inbox / ask`. Importing a second one would violate the single-source rule at L2.

## Decision

Port three things from munder-difflin:

**1. Per-agent long-term memory.** Each agent gets a memory file created at
spawn, which it reads at the start of its work and updates as it goes. It is
self-managed — the agent curates it — and it survives restarts. This is
MemGPT-style self-managed memory, not a transcript.

**2. Git as the coordination and audit layer, with exactly one committer.**
Everything the system knows is files in a repository. **Only the supervising
process commits.** Agents never invoke git; they write plain files. This is the
decision that prevents `.git/index.lock` corruption under many concurrent
agents, and it is not optional.

**3. Single writer per file.** An agent writes only inside its own directory.
Cross-agent delivery happens by a router moving a message from a sender's outbox
to a recipient's inbox in the supervising process. No file is ever written by two
processes.

**Do not port the mailbox or the blackboard.** Orca's orchestration messages
already are the mailbox, and rule 3's routing discipline is a *constraint on how
Orca's router behaves*, not a second message store.

**Do not port the 2D office floor.** It is a fine idea and it is not this
product.

**ruflo's vector retrieval is optional and evidence-gated.** It may be adopted
for semantic retrieval over memory and over the session index
([ADR-0007](./ADR-0007-unified-session-index.md)) if and only if a benchmark
*in this repository* shows it beats the alternative on this workload. ruflo's
published figures are not carried over: its own `CLAUDE.md` marks several as
unverified, and one prominent speedup is documented there as having been measured
against a brute-force fallback rather than the claimed implementation.

## Rationale

The single-committer rule is the whole reason to take this design rather than
invent one. It is a non-obvious constraint discovered under load: git's index
lock is process-global, so N agents committing concurrently in one repository
corrupt each other. Any independently-designed memory layer would hit it later
and more expensively.

Single-writer-per-file is the same shape of lesson: it makes concurrent memory
updates safe by construction rather than by locking.

Git-as-audit is a good fit for this product specifically. The work already
happens in git repositories, the audit trail is diffable and inspectable with
tools users already have, and it costs no new storage engine.

Memory is a contract port rather than a sidecar because it is small, it is
coupled to agent lifecycle events Orca already owns (spawn, turn end, restart),
and there is no standalone binary to reuse.

## Consequences

- **Memory location must respect folder workspaces.** Not every workspace is a
  git worktree; memory has to work when git is absent, degrading to files without
  an audit trail.
- **The committing process is a new responsibility** with a queue and backoff —
  a commit queue, not a commit call. Orca's main process is the natural owner.
- **Memory files are context, and context costs tokens.** Their size needs a
  bound and a curation rule, or every agent turn grows monotonically.
- **Memory contains whatever the agent writes.** Redaction rules apply, and
  `src/main/observability/redactor.ts` is the existing precedent to follow.
- **Retrieval stays out until measured.** No vector store, no embedding pipeline,
  no HNSW index enters the product on the strength of a README.

## Rejected alternatives

**Import munder-difflin's mailbox and blackboard wholesale.** Rejected: Orca's
orchestration messages already cover it, and two message stores means two answers
to "what was this agent told".

**Use a database for agent memory instead of files.** Rejected: files are what
the agent can read and edit with its ordinary tools, they diff, and git gives the
audit trail for free. A database would require a tool surface to be useful to an
agent at all.

**Let each agent commit its own memory.** Rejected explicitly — this is the
`.git/index.lock` failure the single-committer rule exists to prevent.

**Adopt ruflo's memory stack now.** Rejected: large surface, and performance
claims its own documentation flags as unverified. The evidence gate above is the
path back in.

---

## Amendment (implementation)

One correction, and three details the decision left open.

**Correction: the audit repository is Orca's own, not the user's project.**
Read literally, "memory files in a repository with the supervising process as
the only committer" puts agent memory in the workspace and has Orca commit it.
That would be a new and surprising behaviour: `src/main/git/` is read-only today
(`gitExecFileAsync`, `hasCommitObjectViaGitExec` and friends) — Orca has never
created a commit on a user's behalf, and commits landing in someone's project
history are hard to undo.

Memory therefore lives at `<userData>/agent-memory/<workspaceId>/<agentHandle>/memory.md`,
inside a git repository Orca owns outright. The audit trail is unchanged; the
user's history is untouched. It also makes two of this ADR's own requirements
fall out for free: folder workspaces work because nothing depends on the
workspace being a repo, and git being absent degrades to plain files with no
audit trail, reported honestly rather than thrown.

**`workspaceId` is a hash, not the selector.** Worktree selectors contain `/`,
`::` and `:`, so they cannot be path segments. They are hashed
(`ws_<sha256[0:16]>`, the digest shape already used by `ssh-relay-instance-id.ts`)
rather than sanitised, because a rewrite that produced a legal name could map
two different worktrees onto one and silently merge their memory. A coordinator
with no worktree selector is a supported case, not an error; it gets the
`unscoped` workspace.

**Reading memory can never fail a dispatch.** `loadDispatchMemory` returns
`null` for every failure — absent file, unreadable file, a handle that is not a
valid path segment, no Electron app environment. A dispatch that died over an
unreadable memory file would trade a working task for a missing paragraph. The
preamble section is optional in the same way the phase section is: an agent with
no memory gets a byte-identical preamble, which the existing preamble snapshot
test confirms.

**Memory is framed as notes, not instructions.** The preamble says the facts are
the agent's own, that they may be stale, and that what it can verify now wins.
Presenting curated memory as fact would let one wrong note outrank direct
evidence on every later task — the failure mode that makes long-lived memory
worse than none.

**The checkpoint is the phase boundary, and there is one queue per root.**
`commitAgentMemory` is the only way to commit, and it holds the queue for each
memory root in a module-level map: a second `new AgentMemoryCommitQueue(root)`
elsewhere would reintroduce the concurrent `.git/index.lock` corruption the
queue exists to prevent, so there is one place that could make that mistake.
`advanceTaskWorkflow` calls it after every transition — by then whatever the
workers learned during the phase is on disk. The outcome is deliberately
ignored: a missing git binary or a failed commit costs the audit trail, never
the transition.
