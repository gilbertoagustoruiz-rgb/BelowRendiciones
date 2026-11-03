BEGIN;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS project_budgets (
  project_id BIGINT NOT NULL,
  concept_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(project_id,concept_id),
  FOREIGN KEY(project_id,concept_id) REFERENCES project_event_concepts(project_id,concept_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS budget_history (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  concept_id BIGINT NOT NULL REFERENCES event_concepts(id) ON DELETE RESTRICT,
  old_amount NUMERIC(12,2),
  new_amount NUMERIC(12,2),
  reason TEXT NOT NULL CHECK(LENGTH(TRIM(reason)) > 0),
  actor_id BIGINT NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_history_project ON budget_history(project_id,id);
CREATE TABLE IF NOT EXISTS movement_files (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL REFERENCES advance_movements(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  file_mime TEXT NOT NULL,
  file_storage TEXT NOT NULL,
  file_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  sha256 VARCHAR(64) NOT NULL,
  actor_id BIGINT NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(movement_id,sha256)
);
CREATE INDEX IF NOT EXISTS idx_movement_files_movement ON movement_files(movement_id);
COMMIT;
