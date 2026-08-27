# Session index sidecar provenance

`wake-index` (`wake-index.exe` on Windows) is a build output, not source, and is
gitignored. It is produced by `pnpm run build:session-index` from a Wake
checkout; see [ADR-0007](../../docs/fusion/adr/ADR-0007-unified-session-index.md).

|                 |                                                                    |
| --------------- | ------------------------------------------------------------------ |
| Upstream        | Wake — https://github.com/iAmCorey/Wake                            |
| Fork built from | https://github.com/jbqvibecoding/Wake                              |
| Licence         | MIT (see `THIRD_PARTY_NOTICES.md` at the repository root)          |
| Commit          | branch `claude/multi-agent-coding-orchestration-cv000a`, `da127fc` |
| Crate           | `wake-core`, binary target `wake-index`                            |

## Building

```sh
# with a Wake checkout beside this repository, or ORCA_WAKE_SOURCE set to it
pnpm run build:session-index
```

The build passes `--no-default-features`, which drops wake-core's `desktop`
feature and with it the `trash` and `windows-sys` dependencies. A read-only
index has no business being able to move a user's files to the recycle bin, and
dropping the feature makes that structural rather than a promise.

Missing cargo or a missing checkout skips the build rather than failing it:
session search is a degradable capability (ADR-0002), and the CLI reports its
absence. `ORCA_REQUIRE_SESSION_INDEX=1` turns the skip into an error for a
release build that must ship it.

## Why a separate process rather than a Node addon

The sidecar opens other tools' session files — `~/.claude/projects`, Codex's
JSONL rollouts, Copilot's SQLite databases. Keeping it in its own process makes
the read-only guarantee something you can see from outside: it has no handle on
Orca's state, and Wake's own test suite proves a full scan leaves every file's
size and mtime unchanged.

## Platform floor

Linux is the only verified target. See
[`docs/reference/wake-index-platform-floor.md`](../../docs/reference/wake-index-platform-floor.md).
