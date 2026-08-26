# ADR-0004 — agtx's `plugin.toml` is the workflow contract

**Status:** Accepted
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
