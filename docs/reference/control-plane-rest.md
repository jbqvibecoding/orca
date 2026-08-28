# Control-plane REST contract

Six routes under `/v1` that let an external control plane read tasks, read and
set budgets, and read and resolve approvals. Deliberately minimal, per
[ADR-0009](../fusion/adr/ADR-0009-cost-budget-and-control-plane-boundary.md):
org charts, multi-company isolation, SSO, RBAC and GRC are out of scope until
someone asks for them with a use case.

## Where it is served

On the listener that already serves the mobile WebSocket and the web client —
not a second server. That is the whole reason it is safe by default:

| | Inherited from that listener |
| --- | --- |
| Bind address | Loopback only, widening to all interfaces just when a network device has been paired |
| Authentication | The same per-device tokens, so revoking a device closes REST too |
| Transport | TLS when certificates are configured |

## What it does NOT inherit

**The mobile socket's per-device end-to-end encryption.** A REST request cannot
carry it. So the control plane is bearer-token auth over TLS or loopback, and a
request on a plain-HTTP LAN binding is readable in transit in a way a mobile
socket message is not.

This is a real difference between two paths on one port, and it is written down
here rather than left for someone to discover from the source.

## Authentication

```
Authorization: Bearer <device-token>
```

The token is checked *before* routing, so an unauthenticated caller gets `401`
for every path and cannot map the surface by comparing `404` against `405`.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/tasks` | List tasks; `?run=<id>` narrows to one run |
| GET | `/v1/tasks/:id` | One task |
| GET | `/v1/budgets` | Every budget with what has been used against it |
| PUT | `/v1/budgets/:scope` | Set caps; `:scope` is `run` (with `runId` in the body) or `global` |
| GET | `/v1/approvals` | Tasks by approval state; `?state=` defaults to `pending` |
| POST | `/v1/approvals/:taskId` | Record `approved` or `rejected`, with `by` |

Status codes: `200` on success, `400` for a malformed body or value, `401`
unauthenticated, `404` unknown path or record, `405` known path with the wrong
method, `413` body over 64 KiB, `500` for a fault (whose detail stays in the log,
not the response).

### A PUT states the whole budget

An omitted cap is **cleared**, not left alone. A partial update would make "no
cap" and "unchanged" indistinguishable on the wire, and the safer reading of an
ambiguous budget request is the one that does not silently keep an old limit.

`null` clears a dimension explicitly. `0` is a real cap that refuses every
spawn — it is not the same as unset.

## What the numbers mean

The three budget dimensions are not measured the same way, and the response
distinguishes them rather than presenting three equally-current figures:

| Dimension | Source | Lag |
| --- | --- | --- |
| Spawns | Counted from dispatch rows inside the claim's own transaction | **None. Exact.** |
| Tokens | The usage collector's transcript scan | Up to one scan |
| Spend | The usage collector's transcript scan | Up to one scan |

`observed.observedAt` is when the lagging two were measured, and is `null` when
they never have been. **The bound on overshoot is the work in flight between one
scan and the next**: enforcement happens at the spawn boundary, so a cap stops
the *next* spawn, never the ones already running. ADR-0009 chose that boundary
deliberately — interrupting a running agent wastes the work and leaves a worktree
in an undefined state.

Money is integer micros (`microsPerUsd` is echoed in every budget response) so
no float ever reaches the database.

## Example

```sh
TOKEN=<device token>
BASE=http://127.0.0.1:<port>

curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/v1/tasks"

curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"runId":"run_abc","maxSpawns":20,"maxSpendMicros":25000000}' \
  "$BASE/v1/budgets/run"

curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"state":"approved","by":"alice"}' \
  "$BASE/v1/approvals/task_abc"
```

The same operations are available locally as `orca budget show|set|clear`, which
goes over the runtime's own RPC rather than HTTP.

## Not verified

No external control plane has been connected. `control-plane-routes.test.ts`
drives all six routes over real HTTP against a real database, which establishes
the contract is consumable by an ordinary HTTP client — not that paperclip, or
any other specific control plane, has been integrated.
