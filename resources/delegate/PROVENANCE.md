# Delegation sidecar provenance

`ywcrew-standalone.mjs` is a generated artifact, not source. It is vendored
rather than installed because Orca ships it inside the app; see
[ADR-0006](../../docs/fusion/adr/ADR-0006-cross-vendor-delegation.md).

| | |
| --- | --- |
| Upstream | ywcrew — https://github.com/yuwen-cool/ywcrew |
| Licence | MIT (see `THIRD_PARTY_NOTICES.md` at the repository root) |
| Built from | `777fd6c5c0fd5db44ffc4b844fe673ab94ead246` |
| SHA-256 | `ef0061c5ae5a7e7d5e625be867b050a31423dfd4342694368efe1200605ae58a` |

## Regenerating

```sh
# in a ywcrew checkout at the commit you want
npm install
npm run build:standalone
cp dist/ywcrew-standalone.mjs <orca>/resources/delegate/
```

Then update the commit and checksum above. `npm run build` produces this file
alongside ywcrew's ordinary chunked build.

## Why a single self-contained file

ywcrew's ordinary `dist/` leaves `commander`, `zod`, `tinyglobby`, `ignore` and
the MCP SDK as bare imports, so copying that directory alone does not run. The
standalone build inlines them. It is also unsplit on purpose: the delegation
worker re-enters through `process.argv[1] __worker`, and a split build would
import chunks that were never vendored.

It ships as an `extraResources` entry rather than inside `app.asar` because it
is executed as `node <path>`, and Node cannot run a script from an asar archive.
