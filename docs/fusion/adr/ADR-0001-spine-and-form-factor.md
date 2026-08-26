# ADR-0001 — Orca is the spine, and the first form factor is single-machine

**Status:** Accepted
**Date:** 2026-08-26
**Supersedes:** —

## Context

Thirteen forked repositories overlap on "orchestrate coding agents". Merging
them requires choosing which one everything else moves *into*. The choice is
load-bearing: it decides how much code has to be rewritten, which product
surfaces exist on day one, and what the engineering constraints are.

Four candidates were considered against one criterion — how much of the target
product already exists, and therefore how little has to be built.

## Decision

**Orca is the spine.** All other donors move into it.

**The first form factor is single-machine**: desktop application plus CLI, with
everything running locally. A team server and web control plane are deferred to
phase P4.

## Rationale

Orca already owns most of the target surface, verifiably:

- 36 agent CLIs in one union type (`src/shared/tui-agent.ts`), with per-vendor
  launch, auth and usage handling under `src/main/`.
- An orchestration kernel with Run, Task, Dispatch, Worker, Message and decision
  gates (`src/cli/handlers/orchestration/`).
- Worktrees, folder workspaces, SSH execution hosts, ephemeral VMs, six git
  providers, Jira and Linear.
- Desktop UI, mobile companion, background daemon, persistence, observability.
- A skill distribution channel (`src/main/skills/`).

Nothing else in the set has more than a fraction of that, and every alternative
spine implies rebuilding the parts Orca already has.

Orca is also the most *coding-specific* candidate. paperclip's abstractions are
business-shaped (companies, org charts, goals); this product is about shipping
code, and shaping code work as a subtype of business work adds a translation
layer that pays for itself only at team scale — which is not the chosen form
factor.

The single-machine choice follows from the same reasoning. The differentiating
capabilities being merged — delegation, acceptance gates, workflow phases,
session indexing, memory — are all local. Governance is the one that genuinely
needs a server, and it is the one deferred.

## Consequences

- Orca's engineering constraints become the merge's constraints, including
  `max-lines: 300` and the ratchet gates. This is severe enough to need its own
  decision: [ADR-0002](./ADR-0002-integration-boundary.md).
- Orca's existing vocabulary wins every naming collision. Where a donor's term
  clashes — notably "gate" — the donor's term is renamed, not Orca's.
- Orca's cross-platform commitment (macOS, Linux, Windows, WSL) and its SSH
  execution boundary bind every merged capability.
- Deferring the control plane means the *contract* must be designed now so P4 is
  an addition rather than a migration. See
  [ADR-0009](./ADR-0009-cost-budget-and-control-plane-boundary.md).
- Orca's size (~3.3M tracked lines) makes it slow to change. Merged capabilities
  must be small and well-bounded, or they will not land.

## Rejected alternatives

**paperclip as spine.** Best control plane in the set — budgets, approvals, goal
ancestry, multi-company isolation, REST with OpenAPI. But the entire coding
runtime would have to move: 36 vendor integrations, worktrees, SSH hosts, PTY
handling, hook listeners. That inverts the work: it makes the *large*, mature,
coding-specific part the thing being ported. Rejected on volume, and on the
form-factor decision above.

**agtx as spine.** By far the cleanest codebase (~40k lines) with the workflow
model this product needs already built. But it has no GUI, no remote execution,
no governance, and eight vendor adapters against Orca's 36. Choosing it means
building three subsystems that already exist elsewhere. Its *ideas* are adopted
in full — see [ADR-0004](./ADR-0004-phase-workflow-engine.md) — which captures
most of its value without the rebuild.

**A new integration monorepo with donors as submodules.** Keeps every donor
independently syncable with its upstream and avoids a giant diff. Rejected
because it optimises for maintaining thirteen projects rather than shipping one:
the hard problem here is a coherent product, and a shell repository defers that
problem permanently instead of solving it. Note that [ADR-0002](./ADR-0002-integration-boundary.md)
recovers the good half of this idea — donors that are already standalone binaries
stay standalone.

**Build fresh, reuse nothing.** Not seriously considered. The explicit goal is
maximum reuse of working code.
