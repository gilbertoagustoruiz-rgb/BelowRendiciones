BEGIN;
ALTER TABLE expense_reports ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'BORRADOR'
  CHECK (approval_status IN ('BORRADOR','ENVIADO','OBSERVADO','APROBADO'));
ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'SOLICITADO'
  CHECK (workflow_status IN ('SOLICITADO','APROBADO','DESEMBOLSADO','LIQUIDADO'));

CREATE TABLE IF NOT EXISTS advance_expenses (
  expense_id BIGINT PRIMARY KEY REFERENCES expense_reports(id) ON DELETE RESTRICT,
  advance_id BIGINT NOT NULL REFERENCES advance_requests(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advance_expenses_advance ON advance_expenses(advance_id);
CREATE TABLE IF NOT EXISTS advance_movements (
  id BIGSERIAL PRIMARY KEY,
  advance_id BIGINT NOT NULL REFERENCES advance_requests(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('DESEMBOLSO','DEVOLUCION','REEMBOLSO')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference TEXT NOT NULL CHECK (LENGTH(TRIM(reference)) > 0),
  actor_id BIGINT NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_initial_disbursement ON advance_movements(advance_id) WHERE kind='DESEMBOLSO';
CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_movement_reference ON advance_movements(advance_id,kind,reference);
CREATE TABLE IF NOT EXISTS workflow_history (
  id BIGSERIAL PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('expenses','advances')),
  entity_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  actor_id BIGINT NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_history_entity ON workflow_history(entity,entity_id);

-- Database guards also protect existing CRUD endpoints and concurrent requests.
CREATE OR REPLACE FUNCTION guard_expense_workflow() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.approval_status NOT IN ('BORRADOR','OBSERVADO') THEN
      RAISE EXCEPTION 'Solo se pueden eliminar borradores u observados.' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.approval_status NOT IN ('BORRADOR','OBSERVADO') AND
    ROW(NEW.project_id,NEW.concept_id,NEW.producer_id,NEW.document_type,NEW.issuer_ruc,
        NEW.series,NEW.document_number,NEW.issue_date,NEW.amount,NEW.file_key,NEW.file_name,NEW.file_mime,NEW.file_storage)
    IS DISTINCT FROM
    ROW(OLD.project_id,OLD.concept_id,OLD.producer_id,OLD.document_type,OLD.issuer_ruc,
        OLD.series,OLD.document_number,OLD.issue_date,OLD.amount,OLD.file_key,OLD.file_name,OLD.file_mime,OLD.file_storage) THEN
    RAISE EXCEPTION 'La rendición está en revisión o aprobada y no puede editarse.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS expense_workflow_guard ON expense_reports;
CREATE TRIGGER expense_workflow_guard BEFORE UPDATE OR DELETE ON expense_reports FOR EACH ROW EXECUTE FUNCTION guard_expense_workflow();

CREATE OR REPLACE FUNCTION guard_advance_workflow() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.workflow_status <> 'SOLICITADO' THEN
      RAISE EXCEPTION 'No se puede eliminar un anticipo aprobado o desembolsado.' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.workflow_status <> 'SOLICITADO' AND
     (to_jsonb(NEW)-'workflow_status'-'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD)-'workflow_status'-'updated_at') THEN
    RAISE EXCEPTION 'El anticipo aprobado no puede editarse.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS advance_workflow_guard ON advance_requests;
CREATE TRIGGER advance_workflow_guard BEFORE UPDATE OR DELETE ON advance_requests FOR EACH ROW EXECUTE FUNCTION guard_advance_workflow();
COMMIT;
