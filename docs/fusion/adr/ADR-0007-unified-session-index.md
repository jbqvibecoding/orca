# ADR-0007 — `wake-core` ships as a sidecar for read-only cross-tool session indexing

**Status:** Accepted
**Date:** 2026-08-26
**Integration tier:** 1 (sidecar)

## Context

Orca knows about sessions Orca launched. It has no idea that the same developer
ran `claude` in a terminal yesterday, `codex` the day before, and solved this
exact problem in one of them.

That history exists on disk, scattered across a dozen private formats:
`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions` plus a SQLite database,
`~/.local/share/opencode/opencode.db`, `~/.grok/sessions/**/updates.jsonl`, and
so on. Some are JSONL, some SQLite, one is zstd-compressed.

Wake's `wake-core` crate already reads all of them.

## Decision

Ship **`wake-core` as a sidecar binary** providing a read-only index of agent
sessions on the machine, exposed inside Orca as search.

Adopted from Wake:

- **13 adapter modules covering 15 session formats** (Claude Code, Codex, Qoder,
  Copilot, Cursor, OpenCode, OpenCode 2, Kiro, Gemini, Pi, Oh My Pi, Grok, Kimi,
  Antigravity, DeepSeek Harness).
- **SQLite FTS5 trigram full-text search**, which handles CJK text and code
  substrings such as `useEffect(` equally well.
- **Incremental mtime-based rescanning** with a file watcher.
- **The privacy stance, unchanged and non-negotiable**: other tools' directories
  are opened **read-only**; credential files are never read; no background
  network requests.

The index is **disposable** — rebuildable from scratch at any time — and is not
a source of truth for anything.

Orca contributes the search UI, the "resume this session" action routed through
its own terminal machinery, and process supervision of the sidecar.

`wake-core` is already headless: `adapters/`, `db.rs`, `models.rs`, `scanner.rs`,
`watcher.rs`, with a `bin/scan.rs` entry point. The fork's work is a stable
JSON-emitting CLI surface over the query path, not a restructuring.

## Rationale

The adapter set is the entire value, and it is the part that rots: fifteen
undocumented, independently-versioned private formats. Reimplementing them in
TypeScript would mean maintaining fifteen reverse-engineered parsers against
upstreams that change without notice. Running the crate reuses every fix Wake
ships.

Tier 1 also enforces the property that matters most. Read-only access to other
tools' data is a *safety* boundary, not a preference: a bug that writes to
`~/.claude` corrupts a user's real history. Keeping that code in a process whose
entire design centres on read-only access is a stronger guarantee than
re-establishing the rule in a new codebase.

Rust is not an obstacle. Orca already carries a `native/` directory, and the
crate is small (~20k lines total, dependencies included) with no GPU or UI
dependencies in `wake-core` itself.

## Consequences

- **Platform coverage is the gate.** The sidecar must build and ship for macOS,
  Linux and Windows, or P3 declares a floor in `docs/reference/`. Wake's own
  Linux and Windows support is marked experimental upstream, so this is the
  concrete risk in this ADR.
- **Two indexes exist.** Orca's own session state and the cross-tool index are
  separate, and the UI must not imply the cross-tool one is authoritative or
  writable.
- **Resume is Orca's, not Wake's.** The index says where a session is; Orca opens
  it, using its own terminal and worktree machinery.
- **Privacy claims become testable.** "Never writes to another tool's data" needs
  a test that proves it, not a sentence that asserts it.
- **The index unlocks retrieval later.** Semantic search over indexed sessions is
  the natural place for [ADR-0008](./ADR-0008-agent-memory-and-git-audit.md)'s
  optional retrieval work — but only on measured evidence.

## Rejected alternatives

**Reimplement the adapters in TypeScript.** Rejected: fifteen private formats,
including SQLite and zstd paths, maintained by hand against silent upstream
changes.

**Index only sessions Orca launched.** Rejected: that is the status quo, and it
misses precisely the history the developer most often wants — the one from before
they opened Orca.

**Link `wake-core` as a native Node addon rather than a sidecar process.**
A legitimate future optimisation. Rejected initially because a separate process
keeps the read-only guarantee structurally obvious and cannot corrupt Orca's
address space; revisit if IPC cost ever matters, which for a search box it will
not.

**Have each vendor integration in `src/main/` read its own history.** Rejected:
it scatters fifteen format parsers across eighteen vendor directories and
duplicates the FTS index per vendor.
