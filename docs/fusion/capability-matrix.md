# Capability matrix

What each of the thirteen repositories actually contains. Every claim carries an
evidence path so a reviewer can check it instead of trusting it.

**Path convention.** A path with no prefix is inside this repository. A path
prefixed `donor:<repo>/` is inside that donor's checkout, which is a sibling of
this one in the merge working set — it is *not* a path in Orca.

## Scale

Tracked source lines (`*.ts`, `*.tsx`, `*.rs`, `*.py`, `*.sh`; tests included;
`node_modules`, `dist`, `build`, `out`, `target` excluded), rounded:

| Repo | Lines | Language / shape |
| --- | ---: | --- |
| orca | 3,331,000 | TypeScript — Electron desktop + CLI + daemon + mobile |
| paperclip | 1,350,000 | TypeScript — Node server + React UI |
| ruflo | 753,000 | TypeScript + Rust — CLI, MCP tools, memory |
| holaOS | 483,000 | TypeScript — Electron workspace *(excluded, see licensing.md)* |
| oh-my-codex | 439,000 | Rust + TypeScript — Codex workflow layer |
| oh-my-hermes | 430,000 | Python — Hermes skill catalog and router |
| oh-my-claudecode | 406,000 | TypeScript — Claude Code orchestration layer |
| oh-my-agent | 200,000 | TypeScript (bun) — portable `.agents/` harness |
| firstmate | 192,000 | Bash + skills — agent distro |
| munder-difflin | 63,000 | TypeScript — Electron hive |
| agtx | 40,000 | Rust — kanban TUI |
| Wake | 20,000 | Rust — session browser |
| ywcrew | 3,500 | TypeScript — cross-vendor dispatch CLI |

Reproduce with:

```sh
find <repo> \( -name node_modules -o -name dist -o -name build -o -name out -o -name target \) -prune \
  -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.rs' -o -name '*.py' -o -name '*.sh' \) -print0 \
  | xargs -0 cat | wc -l
```

Size is not merit — ywcrew is the smallest repository here and supplies a
capability nothing else has. Size matters only because it predicts how a donor
must be integrated (see [ADR-0002](./adr/ADR-0002-integration-boundary.md)).

## What Orca already owns

These are the layers nothing gets grafted onto. A donor overlapping here loses.

| Capability | Evidence |
| --- | --- |
| 36 agent CLIs, enumerated in one union type | `src/shared/tui-agent.ts` |
| Per-vendor launch, auth, usage and quirk handling | `src/main/{claude,codex,cursor,copilot,droid,devin,amp,antigravity,gemini,grok,kimi,hermes,opencode,openclaude,mimo,minimax,command-code,pi}/` |
| Agent lifecycle hook listening, status cache, relay | `src/shared/agent-hook-listener.ts`, `src/shared/agent-hook-status-cache.ts`, `src/main/agent-hooks/` |
| Orchestration kernel: Run, Task, Dispatch, Worker, Message, decision gate | `src/cli/handlers/orchestration/`, `skill-guides/orchestration.md` |
| Git worktrees and folder workspaces, with removal recovery | `src/main/local-worktree-filesystem.ts`, `src/main/local-worktree-removal-recovery.ts` |
| Six git providers plus Jira and Linear | `src/main/{github,gitlab,gitea,bitbucket,azure-devops,jira,linear}/` |
| SSH remote execution hosts, with an explicit execution boundary | `src/main/ssh/`, `docs/reference/ssh-execution-boundary.md` |
| Ephemeral VMs and Android emulators | `src/main/ephemeral-vm-*.ts`, `src/main/emulator/` |
| Usage and cost collection per vendor, priced from transcripts | `src/main/claude-usage/`, `src/main/codex-usage/`, `src/main/opencode-usage/` |
| Automations: cron, headless dispatch, precheck runner | `src/main/automations/` |
| Skill bundles: authoring, discovery, install, sharing | `src/main/skills/`, `skill-guides/` |
| Desktop UI, mobile companion, background daemon, persistence, observability | `src/renderer/`, `mobile/`, `src/main/orcad/`, `src/main/persistence-*.ts`, `src/main/observability/` |
| Wire compatibility discipline for mixed client/host versions | `docs/reference/remote-wire-compatibility.md` |

## What Orca is missing, and who supplies it

| Gap | Donor | Donor evidence | Integration ([ADR-0002](./adr/ADR-0002-integration-boundary.md) tier) |
| --- | --- | --- | --- |
| Phase workflow engine: named stages, per-stage command and prompt, completion artifacts, entry gating, cyclic phases | agtx | `donor:agtx/plugins/agtx/plugin.toml`, `donor:agtx/src/config/mod.rs` | Contract port |
| Task dependency DAG with levels and unblocked-node computation, free of UI types | agtx | `donor:agtx/src/tui/dep_graph.rs` | Contract port |
| A plugin ecosystem already adapted to GSD, spec-kit, OpenSpec, BMAD, Superpowers, agent-skills, oh-my-claudecode | agtx | `donor:agtx/plugins/` (10 bundled) | Data import |
| Mechanical acceptance gate: only `typecheck` / `test` / `lint` are executable, capped reinforcement, blocks session end | oh-my-agent | `donor:oh-my-agent/.agents/hooks/core/persistent-mode.ts` | Contract port |
| Anti-circumvention verification: a workflow "ran" only if its artifacts exist, including a *distinct* QA agent's and refactor agent's result files | oh-my-agent | `donor:oh-my-agent/.agents/workflows/ralph.md` | Contract port |
| Independent judge: fresh context, briefed on criteria only, re-verifies every criterion each round including prior passes | oh-my-agent | `donor:oh-my-agent/.agents/workflows/ralph/resources/judge-protocol.md` | Contract port |
| Append-only cross-runtime event log with a specified envelope | oh-my-agent | `donor:oh-my-agent/.agents/skills/_shared/runtime/event-spec.md` | Contract port |
| Per-agent check battery (scope violation, charter alignment, secrets, TODO scan, declared outputs) | oh-my-agent | `donor:oh-my-agent/cli/commands/verify/` | Sidecar |
| Spawn/token/spend budget cap enforced before the next spawn | oh-my-agent | `donor:oh-my-agent/.agents/oma-config.yaml` (`session.quota_cap`) | Contract port |
| Cross-vendor one-shot delegation to a *different* vendor's subscription, without polluting the caller's context | ywcrew | `donor:ywcrew/src/core/dispatch.ts`, `donor:ywcrew/src/adapters/` | Sidecar |
| Shadow directory: strict mode executes with only whitelisted files physically present | ywcrew | `donor:ywcrew/src/core/shadow.ts`, `donor:ywcrew/src/context/guard.ts` | Sidecar |
| Evidence verification: each returned file+line claim is checked and marked verified or not | ywcrew | `donor:ywcrew/src/core/evidence.ts` | Sidecar |
| Cross-round follow-up: native session resume on the same backend, history replay across backends | ywcrew | `donor:ywcrew/src/core/threads.ts` | Sidecar |
| Two-level concurrency slots (per-backend and global) with heartbeat-based lazy reclaim | ywcrew | `donor:ywcrew/src/core/lock.ts` | Sidecar |
| Read-only session index across agent CLIs Orca never launched — 13 adapter modules covering 15 session formats | Wake | `donor:Wake/crates/wake-core/src/adapters/` | Sidecar |
| Full-text search over transcripts (SQLite FTS5 trigram; CJK and code substrings) | Wake | `donor:Wake/crates/wake-core/src/services/` | Sidecar |
| Per-agent long-term memory file, self-managed by the agent | munder-difflin | `donor:munder-difflin/src/main/memory.ts`, `donor:munder-difflin/HIVE.md` §1 | Contract port |
| Git as the coordination and audit layer, with a single committer to avoid index-lock corruption | munder-difflin | `donor:munder-difflin/HIVE.md` §2 | Contract port |
| Single-writer-per-file discipline; cross-agent delivery only by a router moving outbox→inbox | munder-difflin | `donor:munder-difflin/HIVE.md` §2 | Design only (Orca messages already cover it) |
| Budget enforcement that actually stops an agent | paperclip | `donor:paperclip/server/src/services/budgets.ts` | Contract port (P4) |
| Approval gates, goal ancestry, org chart, multi-company isolation, REST + OpenAPI | paperclip | `donor:paperclip/server/src/routes/{approvals,goals,companies,openapi}.ts` | Deferred to P4 |
| Scheduled heartbeats that wake agents on a cron | paperclip | `donor:paperclip/server/src/services/cron.ts` | Overlaps `src/main/automations/` — evaluate, do not duplicate |
| Supervision discipline: durable wake queue, never end a turn blind while work is in flight | firstmate | `donor:firstmate/AGENTS.md` §8, `donor:firstmate/bin/fm-watch.sh` | Design only |
| Deterministic phrase/token router with no raw substring matching | oh-my-hermes | `donor:oh-my-hermes/src/routing/chat.py` | Design only |
| Routing precision corpora: negative controls *and* positive interventions, each with its own failure metric | oh-my-hermes | `donor:oh-my-hermes/src/quality/routing_precision.py` | Contract port (test discipline) |
| Generated-artifact drift gates: byte-exact `--check` on every generated doc | oh-my-hermes | `donor:oh-my-hermes/src/skills/catalog.py`, its `docs workflows --check` gate | Design only (Orca has equivalents) |
| Skill and agent catalogues for Claude Code and Codex | oh-my-claudecode, oh-my-codex | `donor:oh-my-claudecode/agents/`, `donor:oh-my-codex/skills/` | Data import |
| Vector/semantic memory retrieval | ruflo | `donor:ruflo/v3/@claude-flow/memory/` | Optional, evidence-gated |

## Overlaps that resolve in Orca's favour

Recording these prevents re-litigating them per PR.

| Overlap | Resolution |
| --- | --- |
| agtx tmux windows + kanban TUI vs Orca panes and workspaces | Orca. Only agtx's workflow *contract* moves; its TUI and tmux layer do not. |
| munder-difflin mailbox/blackboard vs Orca orchestration messages | Orca. `orchestration send/check/reply/inbox/ask` already is the mailbox. |
| ywcrew's own worktree isolation vs Orca worktrees | Orca, for anything Orca launched. ywcrew keeps its shadow directory, which is a different thing: a directory containing *only* whitelisted files. |
| Wake's resume-in-terminal vs Orca terminals | Orca. Wake contributes indexing and search, not launching. |
| paperclip cron heartbeats vs `src/main/automations/` | Orca, unless a concrete gap is demonstrated in P4. |
| ruflo MCP tool surface vs Orca CLI + skills | Orca. No second tool plane. |
| Every donor's agent adapter table vs `src/shared/tui-agent.ts` | Orca. Donors may contribute *missing vendors*, never a parallel table. |

## Licence at a glance

Full detail in [licensing.md](./licensing.md).

| Licence | Repos |
| --- | --- |
| MIT | Wake, firstmate, munder-difflin, oh-my-agent, oh-my-claudecode, oh-my-codex, oh-my-hermes, orca, paperclip, ruflo, ywcrew |
| Apache-2.0 | agtx |
| Modified Apache-2.0 — **excluded** | holaOS |
