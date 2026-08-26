# Fusion: merging thirteen agent-orchestration projects into one coding-focused product

> **Working title.** "Fusion" names the merge programme, not the shipped product.

This directory is the charter for folding twelve open-source agent-orchestration
projects into Orca, producing a single product focused on **multi-agent coding
collaboration**. It exists so that every later code-moving PR has a written,
checkable rationale instead of a case-by-case judgement call.

## 中文摘要

我们把 13 个 fork 的 agent 编排项目合并成一个专注 coding 的多智能体协作编排产品。

- **主干是 Orca**：它已经覆盖了约 70% 的目标面（36 家 agent CLI 适配、编排内核、
  worktree、SSH 远程、桌面 GUI、移动端），把别人往里并的搬运量最小。
- **首要形态是单机**：桌面 App + CLI 优先，团队服务端控制平面推到第二阶段。
- **核心集成原则是"进程边界优先于代码搬运"**：供体本身已经是独立 CLI 或库的，
  一律以 sidecar 进程接入，Orca 侧只写薄适配层。这既是 100% 复用现成代码，
  也绕开了 Orca `max-lines: 300` 的行数门禁。
- **holaOS 零代码引入**：它的许可禁止把它嵌入对外分发的产品，只能作为设计参考。

分层架构见 [architecture.md](./architecture.md)，逐仓库能力对照见
[capability-matrix.md](./capability-matrix.md)，搬运顺序见 [roadmap.md](./roadmap.md)。

## Documents

| Document | What it settles |
| --- | --- |
| [capability-matrix.md](./capability-matrix.md) | What each of the thirteen repositories actually contains, with an evidence path per claim |
| [architecture.md](./architecture.md) | The L0–L7 target layering, which layer each donor feeds, and the vocabulary the layers must share |
| [licensing.md](./licensing.md) | The licence of every donor, why holaOS is excluded, and the attribution the merge owes |
| [roadmap.md](./roadmap.md) | The order code actually moves in, and what "done" means for each phase |
| [adr/](./adr/) | Ten decision records, each with the alternatives that were rejected and why |

## The one-page version

Orca is the spine. It already owns the runtime (PTY, SSH hosts, ephemeral VMs,
worktrees, six git providers), the agent adapter layer (36 CLIs in
`src/shared/tui-agent.ts`), and an orchestration kernel (Run / Task / Dispatch /
Worker / Message / decision gate). None of that gets rewritten.

Five capabilities Orca does not have are what the other repositories supply:

| Missing from Orca | Donor | How it arrives |
| --- | --- | --- |
| Spec-driven **phase workflow engine** — stages, per-stage commands, completion artifacts, gating, dependency DAG | agtx | Contract port ([ADR-0004](./adr/ADR-0004-phase-workflow-engine.md)) |
| **Acceptance gates** — mechanical typecheck/test/lint verdicts, anti-circumvention artifact checks, an independent judge, an append-only event log | oh-my-agent | Contract port over Orca's existing precheck runner ([ADR-0005](./adr/ADR-0005-acceptance-gates-and-event-log.md)) |
| **Cross-vendor one-shot delegation** — ask another vendor's model a bounded question, in a shadow directory, and get verified evidence or a patch back | ywcrew | Sidecar CLI ([ADR-0006](./adr/ADR-0006-cross-vendor-delegation.md)) |
| **Unified session index** — read-only search across sessions that other agent CLIs wrote, including ones Orca never launched | Wake | Sidecar binary ([ADR-0007](./adr/ADR-0007-unified-session-index.md)) |
| **Agent long-term memory + git as the audit layer** | munder-difflin | Contract port ([ADR-0008](./adr/ADR-0008-agent-memory-and-git-audit.md)) |

Two more feed later phases: paperclip supplies budget enforcement and the
control-plane contract ([ADR-0009](./adr/ADR-0009-cost-budget-and-control-plane-boundary.md)),
and the skill catalogues of oh-my-claudecode, oh-my-codex, oh-my-agent, agtx and
oh-my-hermes converge on Orca's skill-bundle channel
([ADR-0010](./adr/ADR-0010-skill-and-workflow-catalog.md)).

## Non-goals

These are written down so scope creep has to argue with a document.

- **No holaOS code, ever.** Its licence forbids embedding it in a distributed
  product. Design lessons only. See [licensing.md](./licensing.md).
- **No ruflo swarm / neural / consensus surface**, and no repetition of its
  performance numbers. Its own `CLAUDE.md` marks several as unverified; only its
  memory-retrieval work is a candidate, and only on measured evidence.
- **No munder-difflin 2D office visualisation.** The collaboration *protocol*
  moves; the Pixi.js floor does not.
- **No multi-tenancy, SSO, or GRC.** Those are paperclip's, and they wait for
  phase P4 at the earliest.
- **No second orchestration kernel.** Anything that looks like Run / Task /
  Dispatch / Worker / Message routes through Orca's existing one.
- **No new `max-lines` suppressions.** If donor code cannot be split to fit, it
  stays behind a process boundary instead. See
  [ADR-0002](./adr/ADR-0002-integration-boundary.md).
