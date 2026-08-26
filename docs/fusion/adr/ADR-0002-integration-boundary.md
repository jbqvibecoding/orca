# ADR-0002 — Process boundaries beat copied code

**Status:** Accepted
**Date:** 2026-08-26

## Context

"Reuse as much existing code as possible" has two readings: copy the code into
this repository, or run the donor as-is and talk to it. The choice is usually
taste. Here it is forced, by two facts about Orca.

**Fact one: Orca lints everything.** `.oxlintrc.json` sets `max-lines: 300` for
`.ts` (400 for `.tsx`, 600 for `.mjs`, 800 for tests), counting non-blank
non-comment lines. Its `ignorePatterns` are only `**/node_modules`, `**/dist`,
`**/out`, and one e2e checkout directory. Any new top-level directory is linted.

**Fact two: the escape hatch is sealed.** `config/scripts/check-max-lines-ratchet.mjs`
freezes the set of files permitted to carry a `max-lines` suppression — 117
entries in `config/max-lines-baseline.txt`, which the gate reports and which may
only shrink. `AGENTS.md` states the rule directly: never add a `max-lines`
disable, never add a per-file bump.

So a verbatim import is not merely discouraged, it fails CI. Donor files that
would need splitting include `donor:agtx/src/tui/app.rs` (10,759 lines),
`donor:ywcrew/src/core/*` and most of paperclip's services. Splitting foreign
code into 300-line modules is a rewrite wearing a copy's clothes: it inherits the
donor's bugs without inheriting its tests or its upstream fixes.

## Decision

**Prefer a process boundary to a code boundary.** Every donor capability is
integrated at exactly one of three tiers, and the tier is recorded in the
capability matrix:

**Tier 1 — Sidecar.** The donor is already a standalone CLI, daemon or library.
It ships as a dependency and Orca talks to it over a stable data contract
(argv + JSON on stdout, or MCP). Orca-side code is argument marshalling, process
supervision, and result rendering — each file comfortably under 300 lines.
*Applies to:* ywcrew, `wake-core`, oh-my-agent's `oma verify`, agtx's binary if
ever needed.

**Tier 2 — Contract port.** The donor's value is a schema plus the behaviour it
implies, not its implementation. The schema and semantics are adopted; the code
is written fresh in Orca's idiom, citing its origin in a comment.
*Applies to:* agtx's `plugin.toml` and phase model, oh-my-agent's event envelope
and gate semantics, munder-difflin's memory and git-audit rules, paperclip's
budget enforcement.

**Tier 3 — Design only.** The lesson transfers; nothing else does. Recorded in
`docs/fusion/`, cited in review, never in `THIRD_PARTY_NOTICES.md`.
*Applies to:* firstmate's supervision discipline, oh-my-hermes's routing method,
holaOS.

Verbatim file copies are the exception, not a tier. They are allowed only for
*data* files — a `plugin.toml`, a skill's Markdown — which carry no line-length
risk and are meant to be shared.

## Rationale

Tier 1 is the highest-reuse option available, not a compromise. Running ywcrew
reuses 100% of ywcrew — including its concurrency locks, its evidence
verification and every bug fix its upstream ships next month. A port reuses the
design and forks the maintenance.

It also happens to be free of the constraint that forced the decision: a sidecar's
source never enters `src/`, so `max-lines` never applies to it.

The failure mode this avoids is specific and common: a large paste, a mechanical
split into arbitrary 300-line chunks to satisfy the linter, and a resulting
module nobody understands or can resync upstream.

## Consequences

- **Sidecars must be installable.** Each needs a distribution story for macOS,
  Linux and Windows, or a declared platform floor. This is a real cost and the
  main argument against Tier 1 in any given case.
- **Contracts get versioned and pinned.** A Tier 2 port records the donor commit
  it was read from, so drift is a scheduled resync rather than a discovery.
- **Process supervision is now product surface.** A sidecar that hangs, dies, or
  is missing must degrade the capability, never the product. Orca's existing
  process and hang-watchdog machinery applies.
- **Tier is decided once, in the capability matrix**, so it stops being a
  per-PR argument.
- **No new `max-lines` suppressions.** If a merged capability cannot be expressed
  in 300-line modules, that is evidence it belongs behind a process boundary.

## Rejected alternatives

**Vendor donors into an unlinted directory.** Add `vendor/` to `ignorePatterns`
and copy freely. Rejected: it defeats a gate the repository deliberately
maintains, produces code nobody owns, and `AGENTS.md` forbids exactly this class
of exemption.

**Publish donors as npm packages and import them as libraries.** Attractive for
the TypeScript donors, and a legitimate future refinement of Tier 1 — a library
import avoids process-spawn overhead. Rejected as the default because it requires
each donor to expose and maintain a library API, which none does today; ywcrew's
API surface is its CLI.

**Port everything (no sidecars).** Uniform, and avoids the installation problem.
Rejected because it discards the upstream relationship: every donor fix would
have to be re-ported by hand, forever.
