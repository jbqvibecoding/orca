# Target architecture

Eight layers. Everything at L2 and below is Orca as it stands today and is not
rewritten. Everything at L3 and above is what the merge adds, and each of those
layers names exactly one primary donor.

```
L7  Governance & control plane   paperclip — budgets, approvals, org, REST        [phase P4; only the contract is fixed now]
L6  Session & knowledge          Wake (wake-core sidecar) · ruflo (optional retrieval)
L5  Cross-vendor collaboration   ywcrew (sidecar CLI) · munder-difflin (memory + git audit)
L4  Acceptance & audit           oh-my-agent (gates, judge, event log) · firstmate (supervision discipline)
L3  Workflow & phases            agtx (plugin.toml contract, phase gating, dependency DAG)
─── added by the merge ─────────────────────────────────────────────────────────
L2  Orchestration kernel         Orca: Run · Task · Dispatch · Worker · Message · decision gate
L1  Agent adapter layer          Orca: 36 CLIs in src/shared/tui-agent.ts · hook listeners
L0  Runtime substrate            Orca: PTY · SSH hosts · ephemeral VMs · worktrees · git providers · GUI · mobile · orcad
```

## Layer contracts

### L0–L2 — Orca, unchanged

L2 is the single source of truth for *who is doing what*. A merged capability
that needs to model work assignment expresses it as an Orca Task and Dispatch;
it does not open a parallel store. `skill-guides/orchestration.md` already states
this rule for agents ("do not substitute non-Orca subagent tools"), and the merge
inherits it for code.

### L3 — Workflow and phases (donor: agtx)

L3 answers *what stage is this task in and what has to be true to leave it*.

It contributes:

- A **workflow plugin contract** — a TOML document declaring, per phase, the
  command sent to the agent, the prompt template, and the completion artifact
  whose existence ends the phase. Source: `donor:agtx/plugins/agtx/plugin.toml`,
  schema in `donor:agtx/src/config/mod.rs`.
- **Derived entry gating.** agtx does not carry a `research_required` flag; a
  phase is directly enterable when its command or prompt contains `{task}`, and
  otherwise requires the previous phase's artifact. Behaviour is inferred from
  the plugin document, not configured twice.
- **A dependency DAG** with topological levels and unblocked-node computation,
  already free of UI and database types and therefore portable as-is in shape:
  `donor:agtx/src/tui/dep_graph.rs`.
- **Ten existing plugin adaptations** (GSD, spec-kit, OpenSpec, BMAD,
  Superpowers, agent-skills, oh-my-claudecode, agtx, agtx-terse, void).

L3 maps onto L2: a workflow instance is a Run; a phase transition is a Task
status change plus a Dispatch; the artifact check is the transition's
precondition. L3 never launches an agent itself.

### L4 — Acceptance and audit (donor: oh-my-agent, discipline from firstmate)

L4 answers *did the work actually happen*. Its defining property is that no LLM
is asked whether the work looks correct: a command exits zero or it does not, a
file is on disk or it is not.

Two vocabularies must stay distinct, because both exist and both are called
"gate" today:

| Term | Meaning | Owner |
| --- | --- | --- |
| **decision gate** | A human (or coordinator) is asked a blocking question and answers it | Orca, existing — `orchestration gate-create` / `gate-resolve` |
| **acceptance gate** | A command's exit code and an artifact's existence decide a verdict; no one is asked | New at L4 |

Use `acceptance gate` for everything L4 introduces. Never widen `gate-*` CLI
commands to cover it.

L4 contributes:

- **The executable allowlist.** Only `typecheck`, `test`, and `lint` run. An
  agent that writes anything else into the state file has it ignored, never run
  (`donor:oh-my-agent/.agents/hooks/core/persistent-mode.ts`). Reinforcement is
  capped so a permanently red gate cannot trap a session.
- **Anti-circumvention artifact checks** — a phase "ran" only if the artifacts it
  must have left exist, including result files from a *distinct* QA agent and a
  *distinct* refactor agent (`donor:oh-my-agent/.agents/workflows/ralph.md`).
- **An independent judge** — a separate agent with fresh context, briefed on the
  criteria only and never on what the implementer claims, re-verifying every
  criterion each round including the ones that already passed
  (`donor:oh-my-agent/.agents/workflows/ralph/resources/judge-protocol.md`).
- **An append-only event log** with a specified envelope, one JSON object per
  line (`donor:oh-my-agent/.agents/skills/_shared/runtime/event-spec.md`).

L4 does not get its own process runner. It calls Orca's existing
`src/main/automations/precheck-runner.ts`, which already executes a command
locally or over SSH with a bounded output tail and a timeout, and therefore
already obeys `docs/reference/ssh-execution-boundary.md`. That boundary is not
negotiable: the execution host owns everything that touches execution, and loss
of contact is never evidence of a failed check — an unreachable host yields
`unverifiable`, never `failed`.

From firstmate, L4 takes discipline rather than code: work in flight must never
end a turn blind, supervision state must be durable on disk rather than in
conversation memory, and a status line is an event, not current state.

### L5 — Cross-vendor collaboration (donors: ywcrew, munder-difflin)

L5 answers *how does one agent get help from a different vendor's model*.

Orca launches agents. L5 is the different case: a bounded question sent to
another vendor's subscription, answered in a separate process, returning a
structured verdict rather than a conversation — with the caller's context
untouched.

From ywcrew:

- **Shadow directory, strict mode** — the callee executes in a directory that
  physically contains only the whitelisted files, so "it could read the rest of
  the repo anyway" stops being true (`donor:ywcrew/src/core/shadow.ts`,
  `donor:ywcrew/src/context/guard.ts`).
- **Evidence verification** — every returned file+line claim is checked against
  the file and marked verified or not; a nonexistent file or an out-of-range
  line is reported as such (`donor:ywcrew/src/core/evidence.ts`).
- **Patch delivery** — edit tasks run in an isolated worktree and deliver a patch
  file; they never write to the caller's repository.
- **Thread resume** — native session resume on the same backend (no KV rebuild),
  chronological history replay across backends with a budget cap
  (`donor:ywcrew/src/core/threads.ts`).
- **Two-level concurrency slots** — per-backend and global, with heartbeat-based
  lazy reclaim of dead runs (`donor:ywcrew/src/core/lock.ts`).

From munder-difflin, the collaboration substrate:

- **Git is the coordination and audit layer**, and **exactly one process
  commits** — concurrent agents write plain files and never invoke git, which is
  how `.git/index.lock` corruption is avoided (`donor:munder-difflin/HIVE.md` §2).
- **Single writer per file.** An agent writes only inside its own directory.
- **Per-agent long-term memory** — a file created at spawn that the agent reads
  and updates itself.

Its mailbox and blackboard patterns do **not** move: Orca's
`orchestration send / check / reply / inbox / ask` already is the mailbox, and
adding a second one would violate the L2 single-source rule.

### L6 — Session and knowledge (donor: Wake; ruflo optional)

L6 answers *what has already been tried, anywhere on this machine*.

Wake's `wake-core` crate is headless today — `adapters/`, `db.rs`, `models.rs`,
`scanner.rs`, `watcher.rs`, plus a `bin/scan.rs` — and indexes 15 session formats
from 13 adapter modules, none of which Orca can see because Orca only knows
sessions it launched.

Two properties are hard requirements and must survive the merge:

- **Read-only over other tools' data.** Agent directories are opened read-only;
  Wake never writes to another tool's files or databases, and never reads
  credential files. The merged product inherits this verbatim.
- **The index is disposable.** It can be rebuilt from scratch at any time.

ruflo's vector retrieval is a candidate for semantic search over that index, but
only against measured evidence produced in this repository. Its published
speedup figures are not carried over; ruflo's own `CLAUDE.md` marks several of
them unverified.

### L7 — Governance and control plane (donor: paperclip; phase P4)

Deferred, because the chosen form factor is single-machine. What is *not*
deferred is the contract: L4's event log and L2's Task model must already carry
the fields a control plane needs — budget attribution, approval state, goal
ancestry — so P4 is an addition rather than a migration. See
[ADR-0009](./adr/ADR-0009-cost-budget-and-control-plane-boundary.md).

One piece of L7 lands early: **budget enforcement that stops an agent**. Orca
already collects usage and prices it; what is missing is refusing the next spawn
when a cap is exceeded.

## Data flow: one task, end to end

```
  user intent
      │
      ▼
  L3  workflow plugin resolves phase → command + prompt + expected artifact
      │
      ▼
  L2  Run created · Task created · Dispatch to a Worker
      │                                  │
      │                                  ├─► L0 worktree created (local or SSH host)
      │                                  └─► L1 vendor CLI launched, hooks attached
      ▼
  agent works ──► L5 may delegate a bounded question to another vendor
      │              (shadow dir · evidence verified · patch returned)
      ▼
  L4  acceptance gate: precheck-runner executes typecheck/test/lint
      │   artifact checks confirm the phase's required outputs exist
      │   judge re-verifies every criterion with fresh context
      │   every verdict appends one line to the event log
      ├── fail ──► back to the agent, reinforcement counter incremented (capped)
      └── pass ──► L3 advances the phase; L2 updates Task status
                        │
                        ▼
                   PR opened / merged  ·  L6 indexes the session  ·  L7 attributes cost
```

## Extension points this design relies on

| Need | Existing Orca surface |
| --- | --- |
| Run a verification command locally or on the execution host | `src/main/automations/precheck-runner.ts` |
| Model work assignment and completion | `src/cli/handlers/orchestration/` |
| Detect that an agent finished a turn or is blocked | `src/shared/agent-hook-listener.ts`, `src/shared/agent-hook-status-cache.ts` |
| Create and reclaim an isolated working copy | `src/main/local-worktree-filesystem.ts` |
| Ship a workflow or skill to users | `src/main/skills/`, `skill-guides/` |
| Attribute spend to a run | `src/main/claude-usage/`, `src/main/automations/run-usage-collection.ts` |
| Cross-version safety when a client and host disagree | `docs/reference/remote-wire-compatibility.md` |

## Constraints every layer inherits

- **SSH execution boundary** — the execution host owns execution; the verdict
  vocabulary is `live` / `unverifiable` / `exited`, with no synonyms
  (`docs/reference/ssh-execution-boundary.md`). An acceptance gate that cannot
  reach its host reports `unverifiable`, never `failed`.
- **Remote wire compatibility** — clients and hosts update independently. A new
  stream opcode must be capability-negotiated; a new optional field is safe
  (`docs/reference/remote-wire-compatibility.md`).
- **Folder workspaces exist.** Not every workspace is a git worktree, so L3's
  artifact checks and L5's patch delivery must both degrade sensibly without git.
- **Cross-platform.** macOS, Linux and Windows, plus WSL. Any sidecar introduced
  by this merge must ship for all of them or declare its platform floor.
- **`max-lines: 300`.** Every file this merge adds to `src/` fits, without a
  suppression. See [ADR-0002](./adr/ADR-0002-integration-boundary.md).
