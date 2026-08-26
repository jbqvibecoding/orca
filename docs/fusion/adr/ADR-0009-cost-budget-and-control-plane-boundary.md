# ADR-0009 — Enforce budgets now, fix the control-plane contract now, build the control plane later

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** 2 for budget enforcement; contract-only for the control plane

## Context

[ADR-0001](./ADR-0001-spine-and-form-factor.md) defers the team control plane to
phase P4 in favour of a single-machine product. That is a scheduling decision,
not an architectural one — and if the intervening phases ignore governance
entirely, P4 becomes a migration instead of an addition.

Orca already **measures** spend: `src/main/claude-usage/` and its siblings scan
vendor transcripts and price them, and `src/main/automations/run-usage-collection.ts`
attributes usage to a run. What is missing is anything that **stops**.

Two donors have the missing half. paperclip enforces monthly per-agent budgets
and describes checkout-plus-budget as atomic, so there is no double-work and no
runaway spend. oh-my-agent caps tokens, spawn count and per-vendor spend via
`session.quota_cap`, and its orchestrator refuses the next spawn when any
dimension is exceeded.

Multi-agent orchestration makes this urgent rather than nice-to-have: parallel
agents multiply burn rate, and a runaway loop across five workers exhausts a
quota before anyone looks at a dashboard.

## Decision

**Land budget enforcement early**, over Orca's existing usage collection:

- A cap with more than one dimension — tokens, spawn count, and spend — following
  `session.quota_cap`'s shape.
- **Enforcement at the spawn boundary.** The next spawn is refused when a
  dimension is exceeded. Refusing before starting work is the only enforcement
  point that does not waste what it interrupts.
- **The check and the claim are atomic**, per paperclip's rule. A check that is
  separate from the claim double-spends under parallelism, which is the exact
  condition this product creates.
- **Exhaustion is an honest stop.** Partial status is recorded on the event log
  ([ADR-0005](./ADR-0005-acceptance-gates-and-event-log.md)) and reported. It is
  never a silent continue and never a fake completion.
- **Delegated runs count** ([ADR-0006](./ADR-0006-cross-vendor-delegation.md)).
  Their `usage` block feeds the same accounting.

**Fix the control-plane contract now, implement it in P4.** Three fields must
exist in the data model from the start, because retrofitting them means
rewriting history:

| Field | Lives on | Why it cannot wait |
| --- | --- | --- |
| Budget attribution | every event and dispatch | Retroactive spend attribution is impossible; unattributed events stay unattributed |
| Approval state | task | A task that was never approvable has no record of who approved it |
| Goal ancestry | task | paperclip's insight is that tasks carry the full "why"; adding a parent chain later cannot reconstruct intent |

The P4 REST surface is deliberately minimal: read tasks, read and set budgets,
read and resolve approvals. Everything else in paperclip's control plane —
org charts, multi-company isolation, SSO, RBAC, GRC — is out of scope until
someone asks for it with a use case.

## Rationale

Enforcement is small, local, and prevents a class of harm the product otherwise
creates. Measuring spend without being able to stop it is the worst position: the
information arrives after the money is gone.

The contract-now/implementation-later split targets the one thing a later phase
genuinely cannot fix. Code can be added at any time; missing fields on past
records cannot be backfilled. Three fields is a small, checkable tax on P1–P3.

Multi-company isolation is deliberately excluded even from the contract. It is
pervasive — paperclip scopes *every* entity by company — and adopting it
speculatively would tax every table for a form factor that was explicitly
deferred.

## Consequences

- Every event written from P1 onward carries budget attribution, whether or not
  anything reads it yet.
- Task records carry approval state and a parent link from P2 onward, even while
  the single-machine product leaves them empty.
- The spawn path gains an atomic check, which touches Orca's agent launch code —
  a hot path with existing concurrency, and the main implementation risk here.
- The cap needs a UI. A refused spawn with no visible reason reads as a bug.
- P4 can adopt paperclip's control plane against a contract that already fits,
  or a different one, without a data migration.

## Rejected alternatives

**Ship the whole paperclip control plane now.** Rejected by
[ADR-0001](./ADR-0001-spine-and-form-factor.md): the form factor is
single-machine, and a server, database and multi-tenant model are a large tax on
a product no team is running yet.

**Defer budgets entirely to P4.** Rejected: parallel agents create runaway-spend
risk *in P1*, the moment delegation lands.

**Warn instead of stopping.** Rejected: a warning during an autonomous run is
observed after the fact, which is when the quota is already gone.

**Enforce mid-run rather than at spawn.** Rejected: interrupting a running agent
wastes the work in flight and leaves a worktree in an undefined state. The spawn
boundary is the clean cut.

**Adopt paperclip's full entity model now to avoid migrating later.** Rejected:
company-scoping every entity is a large, pervasive change in service of a
deferred form factor. Three fields is the proportionate version of the same
insurance.
