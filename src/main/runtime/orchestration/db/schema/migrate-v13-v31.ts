import { migrateMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationsV13ToV31(this: OrchestrationDb, current: number): void {
  if (current < 13 && !this.hasColumn('worker_dispatches', 'runtime_epoch')) {
    this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN runtime_epoch TEXT')
  }
  if (current < 14) {
    this.db.exec(`
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
      `)
  }
  if (current < 15) {
    if (!this.hasColumn('federated_dispatches', 'to_home_imported_sequence')) {
      this.db.exec(
        'ALTER TABLE federated_dispatches ADD COLUMN to_home_imported_sequence INTEGER NOT NULL DEFAULT 0'
      )
    }
    if (!this.hasColumn('remote_dispatch_attachments', 'to_worker_imported_sequence')) {
      this.db.exec(
        'ALTER TABLE remote_dispatch_attachments ADD COLUMN to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0'
      )
    }
    this.db.exec(`
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
      `)
  }
  if (current < 16) {
    this.db.exec(`
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
      `)
  }
  if (current < 17 && !this.hasColumn('remote_dispatch_attachments', 'protocol_version')) {
    this.db.exec(
      'ALTER TABLE remote_dispatch_attachments ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1'
    )
  }
  if (current < 19) {
    this.migrateLegacyContractStorage()
  }
  if (current < 20) {
    this.backfillLegacyQuestionThreads()
  }
  if (current < 21) {
    this.migrateLegacySchedulerLossProvenance()
  }
  if (current < 22) {
    this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle
          ON dispatch_contexts(assignee_handle);
      `)
  }
  if (current < 23) {
    this.backfillWorkerTerminalResources()
  }
  if (current < 24) {
    if (!this.hasColumn('tasks', 'created_by_pane_key')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_pane_key TEXT')
    }
    if (!this.hasColumn('tasks', 'created_by_process_incarnation')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_process_incarnation TEXT')
    }
    if (!this.hasColumn('tasks', 'created_by_run_generation')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_run_generation INTEGER')
    }
  }
  if (current < 25) {
    this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_active_assignee_handle
          ON dispatch_contexts(assignee_handle)
          WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');
      `)
  }
  if (current < 26) {
    migrateMutationReceiptCapacity(this.db)
  }
  if (current < 27 && !this.hasColumn('federated_dispatches', 'to_home_acknowledged_sequence')) {
    this.db.exec(
      'ALTER TABLE federated_dispatches ADD COLUMN to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0'
    )
  }
  if (current < 28) {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_caller_identities (
          transport           TEXT PRIMARY KEY,
          caller_fingerprint  TEXT NOT NULL UNIQUE
        );
      `)
  }
  // Why a column and not a parsed `last_failure`: an operator close and a crash
  // used to write the same sentence, so post-mortem tooling had to reconcile
  // against external logs to tell them apart (STA-4603).
  if (current < 29 && !this.hasColumn('dispatch_contexts', 'termination_reason')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN termination_reason TEXT')
  }
  // Why a side table and not a column on tasks: `status` is one dispatch's
  // execution lifecycle, a phase is where the task sits in its workflow, and a
  // task can be `completed` for one and still owe the other.
  if (current < 30) {
    this.db.exec(`
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
      `)
  }
  // ADR-0009. The budget tables live in this database because the spawn claim is
  // a transaction here: a cap the claim cannot read inside that transaction
  // would need a separate check, and a check separate from the claim
  // double-spends under parallelism.
  if (current < 31) {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS budgets (
          id                TEXT PRIMARY KEY,
          scope             TEXT NOT NULL CHECK(scope IN ('run', 'global')),
          run_id            TEXT,
          max_spawns        INTEGER,
          max_tokens        INTEGER,
          max_spend_micros  INTEGER,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_run ON budgets(run_id) WHERE run_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_global ON budgets(scope) WHERE scope = 'global';
        CREATE TABLE IF NOT EXISTS budget_observations (
          budget_id             TEXT PRIMARY KEY,
          observed_tokens       INTEGER NOT NULL DEFAULT 0,
          observed_spend_micros INTEGER NOT NULL DEFAULT 0,
          observed_at           TEXT NOT NULL DEFAULT (datetime('now')),
          source                TEXT
        );
      `)
  }
  // Existing rows take the defaults: an upgraded database has no approvals and
  // no budget attribution, which is the honest answer rather than a guess.
  // SQLite cannot add a CHECK via ALTER, so an upgraded database enforces
  // approval_state's vocabulary in code only; a fresh one enforces it in both.
  if (current < 31 && !this.hasColumn('tasks', 'approval_state')) {
    this.db.exec("ALTER TABLE tasks ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'not_required'")
    this.db.exec('ALTER TABLE tasks ADD COLUMN approved_by TEXT')
    this.db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT')
  }
  if (current < 31 && !this.hasColumn('dispatch_contexts', 'budget_id')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN budget_id TEXT')
  }
  this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_pane_leaf
        ON dispatch_contexts(${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL})
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');
      CREATE INDEX IF NOT EXISTS idx_dispatch_active_run_assignee_handle
        ON dispatch_contexts(run_id, assignee_handle)
        WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');
      CREATE INDEX IF NOT EXISTS idx_dispatch_active_run_pane_leaf
        ON dispatch_contexts(run_id, ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL})
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');
      CREATE INDEX IF NOT EXISTS idx_dispatch_active_assignee_pane_key
        ON dispatch_contexts(assignee_pane_key)
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');
    `)
  this.createMailboxDeliveryIndexesIfPossible()
}
