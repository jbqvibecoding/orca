import { CURRENT_CONTRACT_VERSION, LEGACY_RUN_ID } from '../contract-constants'
import {
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  RUN_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'

export function createGraphTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS federated_dispatches (
  dispatch_id             TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  environment_name        TEXT NOT NULL,
  peer_fingerprint        TEXT NOT NULL,
  remote_runtime_epoch    TEXT,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  remote_worktree_id      TEXT,
  remote_terminal_handle  TEXT,
  to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
  to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
  dispatch_id             TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  home_peer_fingerprint   TEXT NOT NULL,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  runtime_epoch           TEXT NOT NULL,
  capability_hash         TEXT,
  pane_key                TEXT,
  process_incarnation     TEXT,
  state                   TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                   TEXT NOT NULL DEFAULT 'accepted',
  worktree_id             TEXT,
  terminal_handle         TEXT,
  setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
  effects                 TEXT NOT NULL DEFAULT '[]',
  residual_resources      TEXT NOT NULL DEFAULT '[]',
  to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane
  ON remote_dispatch_attachments(pane_key)
  WHERE state IN ('starting', 'ready');
CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane_suffix
  ON remote_dispatch_attachments(${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE state IN ('starting', 'ready') AND pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS federation_relay_items (
  dispatch_id   TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
  sequence      INTEGER NOT NULL,
  message_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  byte_count    INTEGER NOT NULL,
  acked_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dispatch_id, direction, sequence),
  UNIQUE (dispatch_id, direction, message_id)
);

CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
  ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

CREATE TABLE IF NOT EXISTS remote_questions (
  message_id        TEXT PRIMARY KEY,
  dispatch_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'answered', 'closed')),
  answer_message_id TEXT,
  answer_body       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
  ON remote_questions(dispatch_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  parent_id     TEXT,
  created_by_terminal_handle TEXT,
  created_by_pane_key TEXT,
  created_by_process_incarnation TEXT,
  created_by_run_generation INTEGER,
  task_title    TEXT,
  display_name  TEXT,
  spec          TEXT NOT NULL,
  -- ADR-0009: a task that was never approvable has no record of who approved it,
  -- so the column exists from the start even though the single-machine product
  -- leaves every row at 'not_required'.
  approval_state TEXT NOT NULL DEFAULT 'not_required'
    CHECK(approval_state IN ('not_required', 'pending', 'approved', 'rejected')),
  approved_by   TEXT,
  approved_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN (
      'pending', 'ready', 'dispatched',
      'completed', 'failed', 'blocked'
    )),
  deps          TEXT NOT NULL DEFAULT '[]',
  result        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

-- Why a side table: status is one dispatch's execution lifecycle, while a phase
-- is where the task sits in its workflow. A task can be completed for its
-- planning dispatch and still owe a running phase, so the two never share a
-- row's meaning. Tasks without a workflow simply have no row here.
CREATE TABLE IF NOT EXISTS task_phases (
  task_id               TEXT PRIMARY KEY,
  workflow_name         TEXT NOT NULL,
  workflow_origin       TEXT NOT NULL
    CHECK(workflow_origin IN ('project', 'global', 'builtin')),
  phase                 TEXT NOT NULL
    CHECK(phase IN ('research', 'planning', 'running', 'review')),
  cycle                 INTEGER NOT NULL DEFAULT 0,
  entered_at            TEXT NOT NULL DEFAULT (datetime('now')),
  entry_artifact_ms     INTEGER,
  instruction           TEXT,
  artifact              TEXT,
  last_refusal_cause    TEXT,
  last_refusal_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_phases_phase ON task_phases(phase);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS dispatch_contexts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id             TEXT NOT NULL,
  contract_version    INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION},
  launch_token_hash   TEXT,
  assignee_handle     TEXT,
  assignee_pane_key   TEXT,
  capability_hash     TEXT,
  process_incarnation TEXT,
  capability_revoked_at TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_failure        TEXT,
  -- Why the process is gone, when Orca could establish it. See TerminalExitCause.
  termination_reason  TEXT,
  -- ADR-0009: which budget this spawn drew against. Retroactive spend
  -- attribution is impossible, so the column is written from the first release.
  budget_id           TEXT,
  dispatched_at       TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

-- Why these live in this database and not beside the usage caches: the spawn
-- claim is a transaction here, and a cap it cannot read inside that transaction
-- could not be enforced without a separate check that double-spends under
-- parallelism -- the exact failure ADR-0009 forbids.
-- A NULL dimension is uncapped. Zero is a real cap that refuses everything.
CREATE TABLE IF NOT EXISTS budgets (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL CHECK(scope IN ('run', 'global')),
  -- NULL for the global budget; there is at most one of those.
  run_id            TEXT,
  max_spawns        INTEGER,
  max_tokens        INTEGER,
  -- Money is integer micros. Floating-point dollars lose cents on the way through.
  max_spend_micros  INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_run ON budgets(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_global ON budgets(scope) WHERE scope = 'global';

-- Why only two dimensions here: spawn count is derived by counting dispatch rows
-- in the same transaction, so it is exact and has no second source to drift
-- from. Tokens and spend come from the usage collector, which scans vendor
-- transcripts after the fact, so they are stored observations that lag.
CREATE TABLE IF NOT EXISTS budget_observations (
  budget_id             TEXT PRIMARY KEY,
  observed_tokens       INTEGER NOT NULL DEFAULT 0,
  observed_spend_micros INTEGER NOT NULL DEFAULT 0,
  observed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  source                TEXT
);

CREATE TABLE IF NOT EXISTS decision_gates (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id       TEXT NOT NULL,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'resolved', 'timeout')),
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
  ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE coordinator_pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS coordinator_runs (
  id                  TEXT PRIMARY KEY,
  spec                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle', 'running', 'completed', 'failed')),
  coordinator_handle  TEXT NOT NULL,
  poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  scheduler_lost_at   TEXT
);
  `
}
