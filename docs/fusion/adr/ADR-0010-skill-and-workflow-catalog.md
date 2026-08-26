# ADR-0010 — One distribution channel for skills, with drift and precision gates

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** data import; test discipline is a contract port

## Context

Five donors ship substantial skill and workflow catalogues: oh-my-claudecode's
agents and skills, oh-my-codex's Codex equivalents, oh-my-agent's 30-plus
`.agents/skills/` and its workflow set, agtx's ten workflow plugins, and
oh-my-hermes's generated skill catalogue.

They also ship five different distribution mechanisms — a Claude Code plugin
marketplace, an npm CLI installer, a portable `.agents/` directory, TOML plugins
resolved from three locations, and a Python-generated catalogue with byte-exact
drift gates.

Orca already has a sixth: skill bundles with authoring, discovery, install and
cross-machine sharing (`src/main/skills/`, `skill-guides/`), plus per-agent
deployment paths, because every vendor CLI expects skills somewhere different.

Six mechanisms for one job is the actual problem.

## Decision

**Orca's skill bundle is the only distribution channel.** Donor catalogues arrive
as bundles. No donor's installer is ported.

**Skills arrive with the phase that needs them**, not in a bulk import. A skill
with nothing to invoke it is dead weight that still costs review and maintenance.

**Adopt two quality gates from oh-my-hermes**, which has thought about catalogue
quality more rigorously than anything else in the set:

**1. Routing precision, in both directions.** Trigger changes ship with negative
cases alongside positive ones. oh-my-hermes maintains two corpora with two
distinct failure metrics: `ROUTING_PRECISION_CASES` measures `overroute_count`
(fired when it should not have), and `ROUTING_INTERVENTION_CASES` measures
`missed_intervention_count` (did not fire when it should have). Adding a trigger
without a negative case is incomplete work. Keyword auto-detection across a large
catalogue is exactly where false positives accumulate, and a one-sided corpus
never catches them.

**2. Generated-artifact drift gates.** Where a document is generated from a
catalogue, a `--check` mode compares it byte-for-byte and fails on drift. Never
hand-edit a generated file. Orca already has this pattern —
`verify:bundled-skill-guides`, `verify:skill-bundle-manifest` — so this is
convergence, not novelty.

**Per-agent deployment stays Orca's.** agtx's mapping table (Claude's
`.claude/commands/`, Codex's `.codex/skills/`, Gemini's TOML conversion,
OpenCode's frontmatter stripping, and the rest) is valuable reference for
extending Orca's coverage. It is reference, not a second deployment engine.

**Command-syntax translation is a data table, not a code path.** The canonical
form is written once and translated per vendor — `/ns:command` for Claude and
Gemini, `/ns-command` for OpenCode, Cursor, Grok and Antigravity, `$ns-command`
for Codex. This is a table, and adding a vendor is a row.

## Rationale

Skills are the product's most visible surface: they are what a user actually
invokes. Five installers means five upgrade paths, five failure modes, and no
single answer to "what is installed".

Orca's channel wins by [ADR-0001](./ADR-0001-spine-and-form-factor.md) and
because it is the only one that already handles cross-machine sharing and the
per-vendor path problem.

The oh-my-hermes gates are worth adopting because catalogue quality degrades
invisibly. A skill that fires when it should not is not a crash; it is a slightly
wrong answer, repeatedly, until someone notices. The two-corpus design is what
makes both directions of that failure visible, and its naming matters: grepping
for "underroute" finds nothing, because the guard exists under the intervention
name.

## Consequences

- Donor catalogues need conversion to bundle format. Content is Markdown with
  frontmatter almost everywhere, so this is mechanical — but the trigger metadata
  differs per donor and is where errors will be.
- Trigger changes get more expensive: two corpora to update, not one. That is the
  point.
- Imported skills arrive with attribution obligations
  ([ADR-0003](./ADR-0003-licensing-and-exclusions.md)).
- Multilingual triggers are inherited — oh-my-agent's keyword detection is
  multi-language — and the precision corpora must cover the languages shipped, or
  the gate only protects English.
- Skills referencing donor-specific CLIs (`oma`, `omh`, `agtx`) must be rewritten
  to Orca's surfaces or dropped. A skill invoking a binary the user does not have
  is worse than no skill.

## Rejected alternatives

**Import every donor catalogue at once.** Rejected: hundreds of skills, most with
nothing to trigger them, all requiring maintenance and all diluting discovery.

**Keep each donor's installer alongside Orca's.** Rejected: it is the current
state and it is the problem.

**Skip the routing corpora and rely on review.** Rejected: over-routing is
invisible in review precisely because each individual case looks defensible.

**Adopt oh-my-hermes's Python catalogue generator directly.** Rejected: it would
add a Python runtime to an Electron product for a generation step Orca already
performs in Node. The *discipline* transfers; the implementation does not.
