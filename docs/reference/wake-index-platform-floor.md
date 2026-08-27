# Session index: platform floor

The `orca sessions *` commands are served by `wake-index`, a native sidecar
compiled from the `wake-core` crate. It is the first Rust in Orca's build, and
its platform support is narrower than the rest of the product. This page says
exactly what has been verified and what has not, so nobody has to guess.

## Verified

| | |
| --- | --- |
| Linux x86_64 | **Verified.** Compiles with `--no-default-features`, and the full `orca sessions` surface was exercised against real agent-session fixtures: `scan --full`, `list`, `list --agent`, `search` (including a CJK query and the substring `useEffect(`), and `doctor`. |

`src/cli/session-index-sidecar-run.test.ts` runs that same surface against the
real binary in CI whenever it has been built, so the wire format is checked
against the compiled sidecar rather than against a hand-written fixture.

## Not verified

| | |
| --- | --- |
| macOS (arm64, x86_64) | **Unverified.** Nothing structurally blocks it — `--no-default-features` removes the `windows-sys` dependency, and `trash` goes with it — but no macOS build or run has happened. |
| Windows x64 | **Unverified**, and the higher risk of the two. wake-core's Windows-only code lives behind the `desktop` feature this build turns off, so the compile should not need `windows-sys` at all; that has not been demonstrated. |
| Packaged app on any platform | **Unverified.** The `extraResources` entry is declared, and the CLI resolves `<resourcesPath>/session-index/`, but no packaged build has been produced or launched with the sidecar in place. |

Treat every "unverified" row as work to do before claiming the platform, not as
a known failure. None of them has been observed failing; none has been observed
working either.

## What happens where it is not available

Nothing breaks. A missing sidecar is an
[ADR-0002](../fusion/adr/ADR-0002-integration-boundary.md) degradable capability:

- Every other Orca feature is unaffected — the sidecar is a separate process
  that nothing else depends on.
- `orca sessions search|list|reindex|doctor` report that session search is
  unavailable, name the directories searched, and name the
  `ORCA_SESSION_INDEX_PATH` override.
- A release build that must ship it can set `ORCA_REQUIRE_SESSION_INDEX=1`,
  which turns the build script's skip into an error.

## Toolchain

Building the sidecar needs Rust (`rustup`), which Orca's build does not
otherwise require. `pnpm run build:session-index` probes for `cargo` and skips
with a message when it is absent rather than failing the build. `pnpm run
build:native` calls it on every platform.

It also needs a Wake checkout: beside this repository by default, or wherever
`ORCA_WAKE_SOURCE` points. See
[`resources/session-index/PROVENANCE.md`](../../resources/session-index/PROVENANCE.md).

## The index file is shared with a Wake install

The sidecar keeps its index where Wake keeps its own: `<data dir>/wake/wake.db`
(`~/.local/share/wake/` on Linux, `~/Library/Application Support/wake/` on
macOS, `%LOCALAPPDATA%\wake\` on Windows). `orca sessions doctor` prints the
exact path.

On a machine that also runs Wake, `orca sessions reindex` therefore updates the
same index Wake reads, and vice versa. That is deliberate — it is the same
derived data from the same sources, and rebuilding it twice would only waste the
scan — but it is worth knowing before assuming Orca owns that file. The index is
disposable in both directions: nothing is the source of truth for it, and either
tool can rebuild it from the agent directories at any time. Only the index is
shared; the agent directories themselves are opened read-only by both.

## Why the index is local-only

`orca sessions` takes no `--host`. The index describes agent sessions found
under *this* machine's home directory, so answering the query from a paired
remote runtime would describe the wrong machine. This is the same boundary as
[`ssh-execution-boundary.md`](./ssh-execution-boundary.md) draws for execution,
applied to history: the machine that ran the agent owns the record of it.
