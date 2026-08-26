# ADR-0005 — Acceptance gates run on Orca's precheck runner, and every verdict is logged

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** 2 (contract port), reusing an existing Orca executor

## Context

An agent saying "tests pass, all criteria met" costs it nothing, and nothing
inside the same session can contradict it. Orchestrating more agents multiplies
the narration without adding a single check.

Orca has decision gates — a coordinator is asked a blocking question and answers
it. It has no mechanism that decides anything *without* asking someone.

oh-my-agent is built around exactly that gap, and its mechanisms are mechanical
by construction: a command exits zero or it does not, a file is on disk or it is
not. No model is asked whether the work looks correct.

Orca also already has the executor this needs.
`src/main/automations/precheck-runner.ts` runs a command locally or over SSH,
captures a bounded output tail, enforces a timeout, and reports an exit code.

## Decision

Adopt four mechanisms from oh-my-agent, and run all of them on Orca's existing
precheck runner.

**1. The executable allowlist.** Only `typecheck`, `test` and `lint` are
executable as gate commands, resolved from the project's own scripts. Anything
else written into gate state is ignored, never run. Reinforcement is capped so a
permanently red gate cannot trap a session — after the cap, the session ends
*honestly*, recording partial status, rather than pretending completion.

**2. Anti-circumvention artifact checks.** A phase counts as having run only if
the artifacts it must have left exist — including result files from a *distinct*
QA agent and a *distinct* refactor agent. Missing artifacts mean the phase did
not run, whatever the narration says.

**3. An independent judge.** A separate agent, fresh context, briefed on the
acceptance criteria only and never on what the implementer claims it fixed. It
re-verifies **every** criterion each round, including ones that already passed,
because fixing criterion two is how criterion one silently regresses.

**4. An append-only event log.** Every gate pass, gate failure and decision
appends one JSON object per line, using oh-my-agent's envelope: `eventId`, `ts`,
`sid`, `kind`, `writerPid`, `vendor`, `vendorSid`, `parentEventId`,
`causalityKey`, `payload`.

**Naming.** These are **acceptance gates**. Orca's existing human-blocking gates
remain **decision gates** and keep the `orchestration gate-*` commands. The two
words are never interchanged, and the `gate-*` commands are never widened to
cover acceptance.

**Verdict vocabulary.** `passed` / `failed` / `unverifiable`. A gate that cannot
reach its execution host is `unverifiable`, never `failed` — this is
`docs/reference/ssh-execution-boundary.md` applied to verification, and it is the
single most likely place for this feature to get it wrong.

## Rationale

Reusing the precheck runner is not just economy. It means acceptance gates
inherit the SSH execution boundary for free — the execution host owns execution,
and loss of contact is never evidence of failure. A fresh executor would have to
rediscover that rule, and would probably rediscover it as a bug report.

The allowlist is the load-bearing constraint. Its value is precisely that it
cannot grow at runtime: a gate that can run arbitrary commands is a gate an agent
can talk its way around. Widening it requires a new ADR.

The judge's fresh context is what makes it independent rather than ceremonial. An
implementer reviewing its own claim in its own context does not produce new
information.

The event log is what makes any of this auditable after the run. It is append-only
and cross-runtime by design, which matters here because a single task may involve
several vendors.

## Consequences

- Acceptance gates hang naturally on phase transitions
  ([ADR-0004](./ADR-0004-phase-workflow-engine.md)) and are the P1 deliverable
  that proves this ADR.
- The event log becomes the substrate the control plane reads later
  ([ADR-0009](./ADR-0009-cost-budget-and-control-plane-boundary.md)), so its
  envelope must carry run, vendor and cost attribution from the start.
- "Distinct agent" checks require agent identity in gate state — the QA agent and
  the implementer must be distinguishable, or the check is decorative.
- A project without `typecheck` / `test` / `lint` scripts gets no gate. That is
  correct, and must be reported plainly rather than silently passing.
- Gate failures are normal traffic, not exceptions. The UI must show a red gate
  as a state, not an error.

## Rejected alternatives

**Ask a model to review the work.** Rejected as the primary mechanism: it
reintroduces exactly the unfalsifiable claim the gate exists to replace. The
judge is a *supplement* to mechanical checks, briefed on criteria only, never a
substitute.

**Let projects configure arbitrary gate commands.** Rejected. An agent that can
write the gate command can pass the gate.

**Build a new gate executor.** Rejected: `precheck-runner.ts` exists, already
handles local and SSH targets with bounded output and timeouts, and already obeys
the execution boundary.

**Reuse the `orchestration gate-*` commands.** Rejected: they mean "a human is
being asked". Overloading them would make it impossible to tell, from a Run's
history, whether something was verified or merely approved.
