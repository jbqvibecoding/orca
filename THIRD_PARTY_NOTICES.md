# Third-party notices

Orca includes code from the projects below. Each entry names what was taken and
which paths in this product derive from it, so the notice stays checkable rather
than decorative.

Projects that contributed *design influence only* are not listed here — they are
documented in [`docs/fusion/`](docs/fusion/). Listing a project as a code source
when no code was taken misattributes the work in the other direction.

---

## ywcrew

- Upstream: https://github.com/yuwen-cool/ywcrew
- Used by: `resources/delegate/ywcrew-standalone.mjs`, a self-contained build of
  ywcrew vendored as Orca's cross-vendor delegation sidecar. Build provenance
  and the regeneration procedure are in
  [`resources/delegate/PROVENANCE.md`](resources/delegate/PROVENANCE.md).
- Licence: MIT

```
MIT License

Copyright (c) 2026 ywcrew contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## agtx

- Upstream: https://github.com/jbqvibecoding/agtx
- Used by: `src/main/workflow/builtin-workflow-documents.ts`. The phase
  instruction text in the `standard` and `standard-terse` workflow documents is
  derived from agtx's `plugins/agtx/skills/{research,plan,execute,review}.md`
  and `plugins/agtx-terse/skills/agtx-{research,plan,execute,review}/SKILL.md`.
  The declarative phase model those documents express — a phase chain with a
  per-phase completion artifact and a loop back for rework — is also agtx's.
- Licence: Apache-2.0. See the note below.

**Modifications**, as Apache-2.0 §4(b) requires them to be stated:

- Converted from agtx's per-plugin TOML plus separate skill markdown into a
  single YAML workflow document.
- Removed the passages instructing the agent to fetch its task through agtx's
  MCP server (`mcp__agtx__get_task`). Orca's dispatch preamble already carries
  the task, so the fetch step does not exist here.
- Changed the artifact directory from `.agtx/` to `.orca/`.
- Removed the "stop and wait for further instructions" endings. Orca workers
  report completion through `orca orchestration send --type worker_done`, which
  the dispatch preamble teaches; a second, conflicting stop protocol in the
  phase text would contradict it.
- Dropped agtx's `commands`, `init_script`, `prompt_triggers`, `auto_dismiss`,
  and `copy_files`/`copy_back`/`copy_dirs` fields. They exist to drive a live
  agent TUI over tmux and to install third-party frameworks; Orca dispatches a
  task spec instead and does not execute shell from a workflow document.

**On the licence**: agtx's signals disagree. Its `LICENSE` file is the
Apache-2.0 text (with the copyright appendix left as the unfilled
`[yyyy] [name of copyright owner]` template) and its README carries an
Apache-2.0 badge, while its `Cargo.toml` declares `license = "MIT"`. No
copyright holder is named anywhere in the repository. Both licences permit this
use; this notice attributes under Apache-2.0 as the stricter of the two, which
also satisfies MIT's weaker notice requirement. The discrepancy is recorded here
rather than resolved silently in favour of whichever licence was more convenient.
