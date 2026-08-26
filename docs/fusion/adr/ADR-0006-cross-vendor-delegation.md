# ADR-0006 — ywcrew ships as a sidecar behind `orca agent delegate`

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** 1 (sidecar)

## Context

Orca launches agents: a vendor CLI in a pane, in a worktree, for the duration of
a task. That is the right model for *doing the work*.

It is the wrong model for a different, common need: an agent mid-task wants a
second opinion from a different vendor's model — "have GPT look at this
deadlock", "get three reviews of this design in parallel". Doing that by
switching the current session's model destroys its KV cache; doing it by
launching a full second workspace is heavy and leaves the caller supervising a
pane it does not want.

What is actually needed is a *bounded question, answered out of process,
returning a structured verdict*. ywcrew is 3,500 lines that does exactly this,
and does several hard parts correctly.

## Decision

Ship **ywcrew as a sidecar CLI**, exposed through Orca as `orca agent delegate`
(with a companion verb for the parallel-panel case). Orca contributes argument
marshalling, process supervision, and result rendering. It does **not**
reimplement any of the following, all of which stay ywcrew's:

- **Subscription-based invocation.** Calls go through each vendor's own
  authenticated CLI. No API keys are introduced.
- **Shadow directory, strict mode.** The callee executes in a directory that
  physically contains only the whitelisted files, so "it could read the rest of
  the repo anyway" stops being true. A secret guard blocks credential files,
  path escapes and key-shaped content.
- **Evidence verification.** Every returned file+line claim is checked against
  the file and marked verified or not; a missing file or out-of-range line is
  reported as such rather than passed through.
- **Patch delivery.** Edit tasks run in an isolated worktree — including the
  caller's uncommitted changes, so the callee sees current reality — and deliver
  a patch file. They never write to the caller's repository.
- **Thread resume.** Native session resume on the same backend (no KV rebuild);
  chronological history replay with a budget cap when switching backends.
- **Two-level concurrency slots.** Per-backend and global, with heartbeat-based
  lazy reclaim of dead runs.
- **Detached workers with on-disk state.** Closing the caller does not affect a
  run in flight.
- **Fail-at-dispatch validation.** Missing backend, unauthenticated CLI,
  nonexistent directory, zero-match glob, placeholder model name — all rejected
  when the task is submitted, with the next action stated.

The returned contract — `status`, `summary`, `evidence[]`, `confidence`,
`usage`, `takeover_command` — is the integration surface, and `takeover_command`
is carried through to the UI so a user can take over the sub-agent's session
directly.

Orca's existing `src/shared/agent-headless-command.ts` stays what it is: a
*recogniser* that identifies headless one-shot invocations so they are not
mistaken for interactive agents. It is not extended into a dispatch subsystem.

## Rationale

Tier 1 is right here for the reason Tier 1 exists: ywcrew is already a complete,
tested, standalone CLI, and running it reuses all of it — including upstream
fixes. Porting 3,500 lines of concurrency locking, shadow-directory construction
and evidence verification into 300-line Orca modules would fork the maintenance
and inherit the bugs without the tests.

The capabilities are also genuinely hard to get right. Strict mode's physical
isolation is a stronger guarantee than any permission flag — vendors' read-only
modes are behavioural constraints, whereas an absent file cannot be read. Evidence
verification converts a model's assertions into checkable claims. Neither is
something to reimplement casually.

Delegation is architecturally distinct from Orca's worktrees and does not
duplicate them: a worktree is a full checkout; a shadow directory contains only
the whitelisted files. Both exist because they answer different questions.

## Consequences

- **Distribution.** The sidecar must install on macOS, Linux and Windows. It is
  Node ≥ 20 with committed build output, which is the easiest case in this merge,
  but the story still has to be written down.
- **Missing sidecar degrades the capability, not the product.** `orca agent
  delegate` reports that delegation is unavailable and says how to install it.
- **Contract pinning.** The task JSON and result JSON are pinned to a ywcrew
  version; a schema change upstream is a scheduled resync
  ([ADR-0002](./ADR-0002-integration-boundary.md)).
- **Backend coverage differs from Orca's.** ywcrew supports five backends today
  (Claude, Codex, Grok, Kimi, Antigravity) against Orca's 36 launchable agents.
  Delegation targets are the intersection, and the UI must not offer a target
  the sidecar cannot reach. Widening it is upstream work in the fork.
- **Delegated runs cost money and quota.** Their `usage` block feeds the same
  budget accounting as everything else
  ([ADR-0009](./ADR-0009-cost-budget-and-control-plane-boundary.md)).
- **Delegation events belong in the event log** ([ADR-0005](./ADR-0005-acceptance-gates-and-event-log.md)),
  with the callee's vendor recorded — otherwise a task's cost and provenance are
  incomplete.

## Rejected alternatives

**Build delegation on Orca's own agent launching.** Rejected: it would produce a
second, weaker implementation of shadow directories, evidence verification,
cross-backend history replay and concurrency slots — the four things that make
delegation safe.

**Port ywcrew into `src/`.** Rejected on [ADR-0002](./ADR-0002-integration-boundary.md):
its core modules exceed the line budget, and splitting them mechanically forks
maintenance for no gain.

**Use MCP instead of a CLI boundary.** Reasonable, and a possible future
refinement — ywcrew already has an `mcp` mode. Rejected as the initial path
because the CLI is its primary, best-tested surface and MCP adds a transport
without removing a problem.

**Skip delegation; tell users to open a second workspace.** Rejected: that is the
status quo, and it costs the caller's context and its attention, which is the
whole point of the feature.
