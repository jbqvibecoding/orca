# Licensing and attribution

This merge folds code from twelve repositories into one MIT-licensed product.
That is legally straightforward but not automatic: it requires keeping copyright
notices, adding a third-party notices file, and excluding one donor entirely.

**This document is engineering guidance, not legal advice.** Where money or
distribution is at stake, have counsel confirm it.

## Donor licences

| Repo | Licence | Copyright holder | Compatible with an MIT product? |
| --- | --- | --- | --- |
| Wake | MIT | Corey Chiu | Yes |
| firstmate | MIT | Kun Chen | Yes |
| munder-difflin | MIT | Chaitanya Giri | Yes |
| oh-my-agent | MIT | Eunkwang Shin, Gahyun Kim | Yes |
| oh-my-claudecode | MIT | Yeachan Heo | Yes |
| oh-my-codex | MIT | Yeachan Heo | Yes |
| oh-my-hermes | MIT | oh-my-hermes contributors | Yes |
| paperclip | MIT | Paperclip AI | Yes |
| ruflo | MIT | ruvnet | Yes |
| ywcrew | MIT | ywcrew contributors | Yes |
| orca *(this repo)* | MIT | Lovecast Inc. | — spine |
| agtx | Apache-2.0 | agtx contributors | Yes, with extra obligations — see below |
| **holaOS** | **Modified Apache-2.0** | Holaboss | **No — excluded** |

Verify any row with `head -3 <repo>/LICENSE`.

## holaOS is excluded

holaOS ships a modified Apache-2.0 licence that adds conditions Apache-2.0 does
not have. Two of them are disqualifying for this merge:

> **1.a** Unless explicitly authorized by Holaboss in writing, you may not use
> the holaOS source code to provide a hosted service to third parties, or embed
> holaOS as a component of a product or service that is sold, licensed, or
> otherwise commercially distributed to third parties.

> **1.b** In the process of using holaOS's frontend, you may not remove or modify
> the LOGO or copyright information in the holaOS console or applications.

Embedding holaOS as a component of a distributed product is exactly what this
merge would be doing. Clause 1.b would additionally require carrying Holaboss
branding inside our desktop UI.

**Decision: zero lines of holaOS code enter this product.** Its architecture is
still worth reading — the side-by-side app-and-agent surface and the in-process
harness host are genuinely good ideas — and it may be cited as *prior art* or
*design inspiration*. It may never be cited as a *source*.

Clause 1's carve-out ("internal use within a single organization does not require
a commercial license") does not help: it permits running holaOS internally, not
redistributing pieces of it inside something else.

Note also clause 2.a: Holaboss reserves the right to make the licence stricter.
A dependency whose terms can tighten unilaterally is a poor foundation regardless
of today's wording.

See [ADR-0003](./adr/ADR-0003-licensing-and-exclusions.md).

## agtx: Apache-2.0 obligations

agtx is Apache-2.0 while this product is MIT. Apache-2.0 code can be included in
an MIT-licensed distribution, but Apache-2.0 §4 attaches obligations that MIT
does not, and they follow the code:

- Retain the Apache-2.0 licence text for the incorporated portion.
- Retain copyright, patent, trademark and attribution notices in the source.
- State in modified files that they were changed.
- If the donor ships a `NOTICE` file, reproduce its contents. **agtx currently
  has no `NOTICE` file** (verified: no such file at the repository root), so
  there is nothing extra to reproduce today. Re-check when syncing from upstream.

In practice this is why [ADR-0004](./adr/ADR-0004-phase-workflow-engine.md)
takes agtx's *contract* (the `plugin.toml` schema and phase semantics) rather
than its Rust source: a TOML schema and the behaviour it describes are far
weaker copyright subject matter than a translated implementation, and the
resulting Orca code is original work. Where agtx *files* are copied — the bundled
`plugins/*/plugin.toml` documents, for instance — the obligations above apply in
full and the files keep their headers.

## What this repository must add

Neither this repository nor agtx currently ships a `NOTICE` or
`THIRD_PARTY_NOTICES` file (verified). The merge introduces one.

`THIRD_PARTY_NOTICES.md` at the repository root, with one section per donor
whose code was incorporated, each carrying:

1. Donor name and upstream URL.
2. Its licence, reproduced in full.
3. Its copyright line.
4. **Which parts of this product derive from it**, by path — so the notice stays
   checkable rather than decorative.

A donor that contributed only *design influence* (firstmate's supervision
discipline, oh-my-hermes's routing method, holaOS) does not belong in
`THIRD_PARTY_NOTICES.md`; it belongs in this directory's prose. Listing a project
as a code source when no code was taken is its own kind of inaccuracy.

## Vendoring rules

These follow from [ADR-0002](./adr/ADR-0002-integration-boundary.md), which
prefers process boundaries to copied code, but apply whenever code does move:

- **Copied files keep their original licence header**, plus a one-line provenance
  comment naming the donor, the upstream path, and the commit taken from.
- **Ported contracts cite their origin** in a comment, even though the resulting
  code is original — the citation is what makes the derivation auditable later.
- **Sidecar dependencies** consumed as published packages or binaries are ordinary
  dependencies. They still appear in `THIRD_PARTY_NOTICES.md`, because they ship
  with the product.
- **No mixed-provenance files.** A single file is either original Orca code or a
  clearly marked import. A file that quietly becomes half-donor over successive
  edits cannot be attributed correctly afterwards.

## Trademarks

Licence grants do not include trademark rights (Apache-2.0 §6 says so
explicitly; MIT is silent, which is not permission). Donor names, logos and
wordmarks — Orca, Paperclip, agtx, Wake, holaOS and the rest — are not usable in
this product's branding. Naming them factually ("session indexing derived from
Wake") is normal attribution, not trademark use.
