# ADR-0003 — holaOS is excluded; attribution is a first-class deliverable

**Status:** Accepted
**Date:** 2026-08-26

## Context

Twelve of the thirteen repositories are MIT or Apache-2.0 and combine cleanly
into an MIT product. One is not.

holaOS ships a **modified** Apache-2.0 licence with added conditions. Clause 1.a
forbids embedding holaOS "as a component of a product or service that is sold,
licensed, or otherwise commercially distributed to third parties" without written
authorisation from Holaboss. Clause 1.b forbids removing or modifying holaOS's
logo and copyright information from its frontend. Clause 2.a reserves Holaboss's
right to make the licence stricter later.

Separately, this repository has no `NOTICE` or `THIRD_PARTY_NOTICES` file today,
and neither does agtx — the one Apache-2.0 donor. Attribution has to be built,
not inherited.

## Decision

**No holaOS code enters this product** — not a file, not a function, not a
mechanically translated module. holaOS may be cited as prior art or design
inspiration in `docs/fusion/`. It may never appear as a source in
`THIRD_PARTY_NOTICES.md`, because nothing will have come from it.

**`THIRD_PARTY_NOTICES.md` is created at the repository root** and updated in the
same PR that introduces each donor's code. Each entry names the donor, its
upstream URL, its full licence text, its copyright line, and **which paths in
this product derive from it**.

**Only actual code sources are listed.** Design-influence donors are documented
in prose. Listing a project as a code source when no code was taken misattributes
the work in the other direction.

**agtx's Apache-2.0 obligations travel with agtx's files.** Copied files keep
their headers, modified files say they were modified, and if agtx ever adds a
`NOTICE` file its contents get reproduced. It has none today.

## Rationale

Clause 1.a describes this merge precisely. The internal-use carve-out permits
running holaOS inside one organisation; it does not permit redistributing parts
of it inside something else. Clause 1.b would push Holaboss branding into our own
UI. And clause 2.a means today's reading is not a durable guarantee.

The exclusion costs little. holaOS's distinctive contributions — apps and agent
side by side, an in-process harness host — are product ideas, and ideas are not
what licences restrict. Everything holaOS does that this product needs is either
already in Orca or available from an MIT donor.

Building attribution as a deliverable rather than a cleanup task is the only way
it stays accurate. A notices file assembled at the end, from memory, is
reliably wrong.

## Consequences

- Reviewers must be able to answer "did this come from holaOS?" for any merged
  code. The `docs/fusion/` capability matrix never lists holaOS as a donor,
  which makes the answer checkable rather than a matter of trust.
- `THIRD_PARTY_NOTICES.md` becomes a maintained file with a per-PR obligation.
- Preferring contract ports over code copies
  ([ADR-0002](./ADR-0002-integration-boundary.md)) also reduces attribution
  surface: a schema and its semantics are far weaker copyright subject matter
  than a translated implementation.
- Donor trademarks stay out of this product's branding. Licence grants do not
  convey trademark rights; Apache-2.0 §6 says so explicitly and MIT is silent,
  which is not permission.

## Rejected alternatives

**Ask Holaboss for written authorisation.** Clause 1.a allows it. Rejected for
now: it makes a merge milestone depend on a third party's goodwill, and nothing
holaOS offers is unavailable elsewhere. Revisit only if a genuinely unique holaOS
capability becomes load-bearing.

**Use holaOS only for internal tooling.** Clause 1's carve-out would arguably
permit it. Rejected: it puts a licence boundary *inside* the repository, and the
first accidental import across that boundary is invisible until it ships.

**Relicense the product as Apache-2.0 to simplify agtx compatibility.** Rejected:
Orca is MIT and the spine's licence stands. MIT already accepts Apache-2.0
contributions under §4's terms, so there is no problem to solve.

**Skip the notices file; the licences are permissive.** Rejected. Permissive is
not public domain — MIT requires the copyright notice to travel, and Apache-2.0
§4 adds more. A notices file is also the only durable record of what actually
came from where.
