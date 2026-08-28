# Roadmap

The order code actually moves in, and what "done" means at each step. Each phase
is independently useful: if the programme stops after any of them, what shipped
still works.

Phases are sequenced by **risk retired per unit of work**, not by layer number.
P1 comes before P2 because delegation and acceptance gates can be proven with one
task and no new data model, whereas the workflow engine needs both.

## P0 — Charter *(this phase)*

**Deliverable.** This directory: capability matrix, architecture, licensing,
roadmap, ten ADRs.

**Done when.** Every capability claim carries an evidence path that resolves,
and the two hard constraints — holaOS exclusion, `max-lines` — are written down
with their sources.

**Verification.** See the checklist at the end of this document.

## P1 — Walking skeleton: delegation + acceptance gates

The first phase that runs. It proves the two riskiest ADRs (0002's process
boundary and 0005's gate reuse) with the smallest possible surface.

**Scope.**

- `orca agent delegate` — a CLI verb that shells out to the ywcrew sidecar,
  passing a task descriptor and returning its structured verdict. Orca side is
  argument marshalling, process supervision and result rendering; no
  reimplementation of shadow directories, evidence checking or thread resume.
- Acceptance gates over `src/main/automations/precheck-runner.ts` — the
  `typecheck` / `test` / `lint` allowlist, run against a worktree, producing a
  verdict that distinguishes `passed` / `failed` / `unverifiable`.
- The append-only event log, using oh-my-agent's envelope, written on every gate
  verdict.

**Done when.** One task runs end to end without hand-holding: a worktree is
created, two different vendors' agents work in it, a delegated question comes
back with verified evidence, the acceptance gate runs and records its verdict,
and a PR is opened. A deliberately broken build must produce `failed` and block
advancement; an unreachable SSH host must produce `unverifiable`, never
`failed`.

**Explicitly not in P1.** Phases, plugins, dependency DAG, memory, session index.

## P2 — Workflow engine

**Scope.**

- The `plugin.toml` parser and phase model from
  [ADR-0004](./adr/ADR-0004-phase-workflow-engine.md), mapped onto Orca's Run /
  Task / Dispatch.
- Derived entry gating (a phase is directly enterable when its command or prompt
  contains `{task}`; otherwise it needs the previous phase's artifact).
- The dependency DAG: topological levels, unblocked-node computation, batch
  advancement of unblocked tasks.
- Import of agtx's ten bundled plugins as data.

**Done when.** A task runs `research → plan → execute → review` under at least
two different plugins (one of spec-kit / GSD, plus the built-in), each phase
gated by its artifact, with the P1 acceptance gate running at the transition. A
task with an unsatisfied dependency must refuse to start and say why.

**Risk.** This is where a second orchestration model could accidentally appear.
The review question for every PR in P2 is: *does this store task state anywhere
other than L2?*

## P3 — Memory and session index

**Scope.**

- `wake-core` as a sidecar producing a read-only index of sessions written by
  other agent CLIs, exposed as search inside Orca
  ([ADR-0007](./adr/ADR-0007-unified-session-index.md)).
- Per-agent long-term memory files, plus git-as-audit with a single committing
  process ([ADR-0008](./adr/ADR-0008-agent-memory-and-git-audit.md)).

**Done when.** A session started outside Orca is searchable inside it, with the
index rebuildable from scratch and provably never writing to another tool's
data directory. An agent restarted mid-task resumes with its memory intact.

**Platform gate.** The sidecar ships for macOS, Linux and Windows, or P3 declares
a platform floor in `docs/reference/`.

## P4 — Governance

**Scope.**

- Budget enforcement that refuses the next spawn past a cap, over Orca's existing
  usage collection.
- The minimal REST contract for task / budget / approval so an external control
  plane — paperclip's, initially — can drive the product
  ([ADR-0009](./adr/ADR-0009-cost-budget-and-control-plane-boundary.md)).

**Done when.** A run that exceeds its cap stops, visibly and with the partial
state recorded, rather than silently continuing. The REST contract is consumed
by something other than Orca's own UI at least once.

**Status: landed**, with one clause met narrowly. Budget enforcement sits inside
both spawn claims' existing transactions, so the check and the claim settle
together; exhaustion writes a `budget.exhausted` event carrying what was already
spent. The REST contract is driven end to end over real HTTP by
`control-plane-routes.test.ts`, which establishes it is consumable by an ordinary
HTTP client — **not** that paperclip, or any other external control plane, has
been connected. That integration remains undone.

Two things the phase deliberately makes visible rather than smoothing over:
spawn counts are exact while token and spend figures lag the usage scan by up to
one pass, and the three ADR-0009 contract fields did not in fact all land in
P1–P3 (see that ADR's amendment).

## Continuous, not phased

Two items have no phase because they attach to whatever else is being built:

- **Skill and workflow catalogue convergence**
  ([ADR-0010](./adr/ADR-0010-skill-and-workflow-catalog.md)) — donor skills
  arrive as skill bundles alongside the phase that needs them.
- **Third-party notices** — `THIRD_PARTY_NOTICES.md` is updated in the same PR
  that introduces a donor, never in a later cleanup pass.

## Risks and rollbacks

| Risk | Signal | Rollback |
| --- | --- | --- |
| A sidecar's platform coverage is worse than Orca's | Windows or WSL failures in P1/P3 | Ship the sidecar as optional; the capability degrades instead of the product failing |
| Donor upstreams drift and the ported contract goes stale | A donor's schema changes shape | Contracts are versioned and pinned to the commit they were read from; drift is a scheduled resync, not a surprise |
| Acceptance gates become theatre | Gates that always pass, or an allowlist that grows | The allowlist is `typecheck` / `test` / `lint` and widening it needs a new ADR |
| A second orchestration model appears | Task state stored outside L2 | Named as a P2 review question; the capability matrix's "overlaps" table is the precedent |
| Scope creep into control-plane territory | Multi-tenancy, SSO, RBAC work before P4 | The non-goals list in the README |
| ruflo's unverified numbers get repeated | A performance claim without a benchmark in this repo | Retrieval work is evidence-gated by ADR-0008 |

## P0 verification checklist

Run from this repository's root, with donor checkouts as siblings.

```sh
# 1. Every Orca path cited in this directory resolves.
grep -ohE '`(src|docs|config|skill-guides|mobile|native)/[A-Za-z0-9._/*{}-]+`' docs/fusion -r \
  | tr -d '`' | sort -u | while read -r p; do
      case "$p" in *'*'*|*'{'*) continue;; esac
      [ -e "$p" ] || echo "MISSING (orca): $p"
    done

# 2. Every donor path cited resolves, in the sibling checkout.
#    This file is excluded: it quotes the pattern, so it would match itself.
grep -ohE 'donor:[A-Za-z0-9._/@{}-]+' docs/fusion -r --exclude=roadmap.md \
  | sed 's/^donor://' | sort -u \
  | while read -r p; do
      case "$p" in *'{'*) continue;; esac
      [ -e "../$p" ] || echo "MISSING (donor): $p"
    done

# 3. holaOS appears only as an exclusion, never as a source.
grep -rin 'holaos' docs/fusion

# 4. The engineering gates are unmoved — this phase adds only Markdown.
node config/scripts/check-max-lines-ratchet.mjs   # no dependencies needed
pnpm run check:reliability-gates                  # needs pnpm install first
```

Checks 1 and 2 skip paths containing glob or brace expansion, which are written
as families on purpose; spot-check those by hand — currently
`src/main/ephemeral-vm-*.ts`, `src/main/persistence-*.ts`, and the
`{approvals,goals,companies,openapi}.ts` family in the capability matrix.

Check 3 should surface hits only in `README.md`, `capability-matrix.md`,
`licensing.md`, `adr/ADR-0002-integration-boundary.md` (its design-only tier
list), `adr/ADR-0003-licensing-and-exclusions.md`, and this file. Any hit
elsewhere means holaOS has been cited as a source, which
[ADR-0003](./adr/ADR-0003-licensing-and-exclusions.md) forbids.

Check 4 currently reports `max-lines ratchet OK — 117 grandfathered
suppression(s), no new bypasses`.
