# ADR-0004 — agtx's `plugin.toml` is the workflow contract

**Status:** Accepted, amended 2026-08-27 (see *Amendment* at the end)
**Date:** 2026-08-26
**Integration tier:** 2 (contract port), plus data import of the plugin files

## Context

Orca's orchestration kernel models *who is doing what*: Run, Task, Dispatch,
Worker, Message, decision gate. It does not model *what stage the work is in*.
There is no notion of "this task is in the planning phase, it leaves that phase
when `plan.md` exists, and until then it may not be executed".

Every spec-driven methodology in circulation — GSD, spec-kit, OpenSpec, BMAD,
Superpowers — is exactly that model, and agtx already has a working abstraction
over all of them: a single TOML document per workflow.

## Decision

Adopt agtx's `plugin.toml` as **the workflow contract** for this product,
including its semantics:

- **Phases** with, per phase, a command sent to the agent, a prompt template
  (`{task}`, `{task_id}`, `{phase}`), and a **completion artifact** whose
  existence ends the phase. Artifact paths support wildcards.
- **Derived entry gating.** A phase is directly enterable when its command or
  prompt contains `{task}`; otherwise it requires the previous phase's artifact;
  a phase with neither command nor prompt is ungated. Behaviour is *inferred*
  from the document rather than configured separately.
- **Cyclic workflows** — review may return to planning with an incrementing
  phase counter.
- **Per-phase agent selection**, so research, implementation and review can run
  on different vendors.
- **Plugin resolution order**: project-local, then user-global, then bundled,
  with a bundled fallback when a disk copy fails to load.
- **A task records its plugin at creation.** Changing the project's plugin
  affects new tasks only.
- **`copy_files` / `copy_dirs` / `copy_back`** for moving files into a fresh
  working copy and results back out.

Adopt the **dependency DAG** alongside it: topological levels, unblocked-node
computation, and batch advancement of unblocked tasks. The donor module
(`donor:agtx/src/tui/dep_graph.rs`) is already free of UI and storage types, so
its shape ports directly.

**Import agtx's ten bundled plugin documents as data** — they are TOML, they
carry no `max-lines` risk, and they are meant to be shared.

**Do not port agtx's TUI or tmux layer.** Orca owns panes, workspaces and
worktrees.

Mapping onto L2: a workflow instance is a Run; a phase transition is a Task
status change plus a Dispatch; the artifact check is the transition's
precondition; a dependency edge is a Task dependency. **No new task store.**

## Rationale

The contract is small, declarative, proven against five external methodologies,
and orthogonal to how agents are launched — which is exactly the seam where Orca
needs it. Everything specific to agtx's own runtime lives outside the TOML.

Derived gating deserves particular note: agtx explicitly replaced a
`research_required` boolean with inference from the document. That removes a
class of bug where the flag and the phase definitions disagree, and it is worth
inheriting deliberately rather than reintroducing the flag.

The port is Tier 2 rather than Tier 1 because the engine must live inside Orca's
transaction boundary — it reads and writes Task state — and because a Rust
sidecar owning phase transitions would put the state machine outside the process
that owns the state.

## Consequences

- Phase transitions become the natural place to hang acceptance gates
  ([ADR-0005](./ADR-0005-acceptance-gates-and-event-log.md)): the artifact check
  proves the phase produced something, the gate proves it works.
- The plugin document becomes a compatibility surface. Upstream agtx changes to
  the schema are a scheduled resync against a pinned commit, per
  [ADR-0002](./ADR-0002-integration-boundary.md).
- Artifact checks assume a filesystem, not git — which is required anyway,
  because Orca supports folder workspaces as well as worktrees.
- The `{task}` placeholder must survive prompt delivery intact. agtx learned this
  the hard way, twice: prompts are quoted twice on the way to a pane, and an
  unescaped inner quote silently drops the entire task text. Orca's own prompt
  injection path must be checked against the same failure before P2 ships.
- Ten plugins arrive with their upstream attribution obligations
  ([ADR-0003](./ADR-0003-licensing-and-exclusions.md)).

## Rejected alternatives

**Design a fresh workflow schema.** Rejected: it would be agtx's schema with
different key names, and would forfeit five existing methodology adaptations.

**Adopt one methodology directly (spec-kit or BMAD) as the built-in.** Rejected:
picking a winner strands users of the others, and the pluggable layer is cheap
because it already exists.

**Run agtx as a sidecar and let it own phases.** Rejected: it would split
authority over task state across two processes and two databases, violating the
single-source rule at L2.

**Model phases as Orca decision gates.** Rejected: a decision gate blocks on a
*human answer*. A phase transition blocks on an *artifact* and a *command exit
code*. Conflating them is the naming collision this merge is explicitly
resolving.

## Amendment — 2026-08-27, from building it

Four claims above did not survive implementation. They are corrected here rather
than edited away, so the record shows what the design got wrong.

**1. The dependency DAG was already Orca's.** This ADR proposed porting agtx's
`dep_graph.rs`. Orca already promotes `blocked` tasks to `ready` when their
dependencies complete (`promoteReadyTasks` in
`src/main/runtime/orchestration/db/tasks/task-store.ts`) and already reconciles
convergence (`coordinator-dag-convergence.ts`). Nothing was ported. agtx's
contribution is the **phase model**, not the DAG.

**2. The document is YAML, not TOML.** Orca has no TOML parser and avoids one
deliberately — its only TOML code is a byte-preserving line scanner for Codex's
`config.toml` that cannot produce a document. Orca already ships `yaml` and
already reads a bounded repo config with it (`src/shared/orca-yaml.ts`), so the
workflow document reuses that parser and its size/alias bounds. agtx's TOML was
converted once, offline. The contract is the same; only the syntax changed.

**3. "Import agtx's ten bundled plugin documents as data" is not achievable.**
Seven of the ten (gsd, spec-kit, openspec, bmad, superpowers, oh-my-claudecode,
agent-skills) are dispatch tables of third-party slash commands
(`/gsd:plan-phase {phase}`) that only exist because an `init_script` first
`npx`-installs that framework into the working copy. Orca dispatches a task spec
rather than typing into a live pane, and does not execute shell from a workflow
document, so importing those seven would have shipped seven documents that
silently do nothing. Two documents ship instead — `standard` and
`standard-terse`, from agtx's own skill markdown, which is the part that carries
real phase instructions. Supporting the other seven is a separate question about
whether Orca should drive framework CLIs at all, not a data import.

**4. Derived entry gating changed its rule.** agtx derives "this phase can start
cold" from whether the prompt contains `{task}`, because there the prompt typed
into the pane is the worker's only channel. Orca's dispatch preamble always
carries the task, so that test marks every phase startable and means nothing.
The rule here is instead: **a phase waits for its predecessor when that
predecessor declares an artifact.** Same intent — do not start work whose input
does not exist yet — expressed against something Orca can actually observe.

Two decisions were also narrowed on security grounds and are recorded as
exclusions, not oversights: `init_script` is not supported (a config document
must not execute arbitrary shell — Orca gates hook command sources for exactly
this reason), and artifact patterns are restricted to workspace-relative paths
with at most one whole `*` segment, validated at parse time *and* after template
substitution, because the pattern is joined onto a workspace root.

The `{task}` prompt-delivery hazard this ADR flagged does not arise: Orca passes
the phase instruction inside the dispatch preamble as text, never as shell
argv, so there is no quoting layer to lose it in.

Two further departures the build forced:

**`cycle_to: <phase>` replaces `cyclic: true`.** A boolean says a workflow loops
but not where to, and agtx's review loop returns to planning rather than to the
read-only research phase ahead of it. Naming the target is one field instead of
two and states the actual behavior.

**A cyclic phase needs to tell its own output from the previous pass's.** The
artifact path is usually the same file on every pass, so a second pass would
advance the instant it began, on evidence the first pass produced. The phase row
records the artifact's modification time *at the moment the phase was entered*
and the check compares against that. Deliberately not a wall clock: on an SSH
workspace the file's timestamp comes from the remote host while `Date.now()`
comes from ours, and even locally a filesystem's timestamp granularity can be
coarser than the clock — the first implementation used a wall clock and failed
against real files for exactly that reason. A host that reports no modification
time at all counts as fresh, because an absent capability must not deadlock a
phase forever.
