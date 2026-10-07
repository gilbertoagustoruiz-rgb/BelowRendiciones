BEGIN;

CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  ruc VARCHAR(11) NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{11}$'),
  responsible_person VARCHAR(180) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_concepts (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS personnel (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(180) NOT NULL,
  document_number VARCHAR(20) NOT NULL,
  profile VARCHAR(30) NOT NULL CHECK (profile IN ('PRODUCTOR','SUB PRODUCTOR','EJECUTIVO')),
  password_hash TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVO' CHECK (status IN ('ACTIVO','INACTIVO')),
  legacy_source VARCHAR(30),
  legacy_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_personnel_document_profile UNIQUE (document_number, profile),
  CONSTRAINT uq_personnel_legacy UNIQUE (legacy_source, legacy_id)
);

DO $$
BEGIN
  IF to_regclass('public.producers') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO personnel (full_name, document_number, profile, legacy_source, legacy_id)
      SELECT name, dni, 'PRODUCTOR', 'producers', id
      FROM producers
      ON CONFLICT (legacy_source, legacy_id) DO NOTHING
    $sql$;
  END IF;

  IF to_regclass('public.subproducers') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO personnel (full_name, document_number, profile, legacy_source, legacy_id)
      SELECT name, dni, 'SUB PRODUCTOR', 'subproducers', id
      FROM subproducers
      ON CONFLICT (legacy_source, legacy_id) DO NOTHING
    $sql$;
  END IF;

  IF to_regclass('public.executives') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO personnel (full_name, document_number, profile, legacy_source, legacy_id)
      SELECT name, dni, 'EJECUTIVO', 'executives', id
      FROM executives
      ON CONFLICT (legacy_source, legacy_id) DO NOTHING
    $sql$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  contact_name VARCHAR(180) NOT NULL,
  service_type VARCHAR(180) NOT NULL,
  project_code VARCHAR(60) NOT NULL UNIQUE,
  project_name VARCHAR(220) NOT NULL,
  event_location VARCHAR(250) NOT NULL,
  number_of_dates INTEGER NOT NULL CHECK (number_of_dates > 0),
  commission NUMERIC(5,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  exchange_rate NUMERIC(10,4),
  producer_id BIGINT NOT NULL REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  subproducer_id BIGINT REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE SET NULL,
  executive_id BIGINT NOT NULL REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'PEN';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(10,4);

UPDATE projects
SET currency='PEN'
WHERE currency IS NULL OR currency NOT IN ('PEN','USD');

UPDATE projects
SET exchange_rate=NULL
WHERE currency='PEN';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_currency_check;
ALTER TABLE projects ADD CONSTRAINT projects_currency_check
  CHECK (currency IN ('PEN','USD')) NOT VALID;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_exchange_rate_check;
ALTER TABLE projects ADD CONSTRAINT projects_exchange_rate_check
  CHECK (
    (currency='PEN' AND exchange_rate IS NULL)
    OR
    (currency='USD' AND exchange_rate IS NOT NULL AND exchange_rate > 0)
  ) NOT VALID;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_commission_check;
ALTER TABLE projects ADD CONSTRAINT projects_commission_check
  CHECK (commission >= 0 AND commission <= 100) NOT VALID;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_producer_id_fkey;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_subproducer_id_fkey;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_executive_id_fkey;

DO $$
BEGIN
  IF to_regclass('public.producers') IS NOT NULL THEN
    UPDATE projects p
    SET producer_id = per.id
    FROM personnel per
    WHERE per.legacy_source='producers'
      AND per.legacy_id=p.producer_id;
  END IF;

  IF to_regclass('public.subproducers') IS NOT NULL THEN
    UPDATE projects p
    SET subproducer_id = per.id
    FROM personnel per
    WHERE per.legacy_source='subproducers'
      AND per.legacy_id=p.subproducer_id;
  END IF;

  IF to_regclass('public.executives') IS NOT NULL THEN
    UPDATE projects p
    SET executive_id = per.id
    FROM personnel per
    WHERE per.legacy_source='executives'
      AND per.legacy_id=p.executive_id;
  END IF;
END $$;

ALTER TABLE projects ADD CONSTRAINT projects_producer_id_fkey
  FOREIGN KEY (producer_id) REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE projects ADD CONSTRAINT projects_subproducer_id_fkey
  FOREIGN KEY (subproducer_id) REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE projects ADD CONSTRAINT projects_executive_id_fkey
  FOREIGN KEY (executive_id) REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS project_event_concepts (
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concept_id BIGINT NOT NULL REFERENCES event_concepts(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, concept_id)
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL,
  concept_id BIGINT NOT NULL,
  producer_id BIGINT NOT NULL REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  document_type VARCHAR(2) NOT NULL CHECK (document_type IN ('01','03')),
  issuer_ruc VARCHAR(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
  series VARCHAR(4) NOT NULL,
  document_number VARCHAR(20) NOT NULL,
  issue_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  file_name VARCHAR(255) NOT NULL,
  file_mime VARCHAR(120) NOT NULL,
  file_storage VARCHAR(20) NOT NULL DEFAULT 'local',
  file_key VARCHAR(700) NOT NULL,
  validation_status VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
  sunat_estado_cp VARCHAR(10),
  sunat_estado_ruc VARCHAR(10),
  sunat_cond_domi_ruc VARCHAR(10),
  sunat_message TEXT,
  sunat_observations JSONB NOT NULL DEFAULT '[]'::jsonb,
  sunat_response JSONB,
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_expense_project_concept
    FOREIGN KEY (project_id, concept_id)
    REFERENCES project_event_concepts(project_id, concept_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT uq_expense_document
    UNIQUE (issuer_ruc, document_type, series, document_number)
);

ALTER TABLE expense_reports DROP CONSTRAINT IF EXISTS expense_reports_producer_id_fkey;

DO $$
BEGIN
  IF to_regclass('public.producers') IS NOT NULL THEN
    UPDATE expense_reports er
    SET producer_id = per.id
    FROM personnel per
    WHERE per.legacy_source='producers'
      AND per.legacy_id=er.producer_id;
  END IF;
END $$;

ALTER TABLE expense_reports ADD CONSTRAINT expense_reports_producer_id_fkey
  FOREIGN KEY (producer_id) REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE expense_reports DROP CONSTRAINT IF EXISTS expense_reports_document_number_check;
ALTER TABLE expense_reports
  ALTER COLUMN document_number TYPE VARCHAR(20)
  USING LPAD(document_number::text,8,'0');

UPDATE expense_reports
SET document_number=LPAD(document_number,8,'0')
WHERE document_number ~ '^[0-9]+$'
  AND LENGTH(document_number) < 8;

ALTER TABLE expense_reports ADD CONSTRAINT expense_reports_document_number_check
  CHECK (document_number ~ '^[0-9]+$') NOT VALID;

CREATE TABLE IF NOT EXISTS advance_requests (
  id BIGSERIAL PRIMARY KEY,
  company VARCHAR(40) NOT NULL CHECK (company IN ('BELOW SAC','BELOW TRADE SAC')),
  request_date DATE NOT NULL DEFAULT CURRENT_DATE,
  applicant_name VARCHAR(180) NOT NULL,
  account_number VARCHAR(40) NOT NULL,
  account_type VARCHAR(10) NOT NULL CHECK (account_type IN ('AHORRO','CTE')),
  account_holder VARCHAR(180) NOT NULL,
  bank VARCHAR(120) NOT NULL,
  cci VARCHAR(40),
  beneficiary_document VARCHAR(20) NOT NULL,
  beneficiary_name VARCHAR(220) NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  project_id BIGINT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  deposit_date DATE NOT NULL,
  settlement_date DATE NOT NULL,
  observations TEXT NOT NULL,
  expected_document_type VARCHAR(30) NOT NULL CHECK (expected_document_type IN ('RH','FACTURA','BOLETA','OTRO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_producer ON projects(producer_id);
CREATE INDEX IF NOT EXISTS idx_projects_subproducer ON projects(subproducer_id);
CREATE INDEX IF NOT EXISTS idx_projects_executive ON projects(executive_id);

CREATE INDEX IF NOT EXISTS idx_expenses_project ON expense_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_concept ON expense_reports(concept_id);
CREATE INDEX IF NOT EXISTS idx_expenses_producer ON expense_reports(producer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_validation ON expense_reports(validation_status);

CREATE INDEX IF NOT EXISTS idx_advance_requests_project ON advance_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_advance_requests_request_date ON advance_requests(request_date);
CREATE INDEX IF NOT EXISTS idx_advance_requests_deposit_date ON advance_requests(deposit_date);

CREATE INDEX IF NOT EXISTS idx_personnel_profile ON personnel(profile);
CREATE INDEX IF NOT EXISTS idx_personnel_status ON personnel(status);

INSERT INTO event_concepts (name) VALUES
  ('PRODUCCIÓN TÉCNICA'),
  ('ESTRUCTURAS Y MOBILIARIO'),
  ('CATERING'),
  ('IMPLEMENTACIONES'),
  ('DISEÑO Y PRODUCCIÓN')
ON CONFLICT (name) DO NOTHING;

DO $
BEGIN
  IF to_regclass('public.advance_reports') IS NOT NULL THEN
    ALTER TABLE advance_reports DROP CONSTRAINT IF EXISTS advance_reports_producer_id_fkey;

    IF to_regclass('public.producers') IS NOT NULL THEN
      UPDATE advance_reports ar
      SET producer_id = per.id
      FROM personnel per
      WHERE per.legacy_source='producers'
        AND per.legacy_id=ar.producer_id;
    END IF;

    ALTER TABLE advance_reports ADD CONSTRAINT advance_reports_producer_id_fkey
      FOREIGN KEY (producer_id) REFERENCES personnel(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $;

DO $
BEGIN
  IF to_regclass('public.producers') IS NOT NULL THEN
    EXECUTE 'DROP TABLE producers';
  END IF;
  IF to_regclass('public.subproducers') IS NOT NULL THEN
    EXECUTE 'DROP TABLE subproducers';
  END IF;
  IF to_regclass('public.executives') IS NOT NULL THEN
    EXECUTE 'DROP TABLE executives';
  END IF;
END $$;

COMMIT;
