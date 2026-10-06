BEGIN;

CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  ruc VARCHAR(11) NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{11}$'),
  responsible_person VARCHAR(180) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS producers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  dni VARCHAR(8) NOT NULL UNIQUE CHECK (dni ~ '^[0-9]{8}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subproducers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  dni VARCHAR(8) NOT NULL UNIQUE CHECK (dni ~ '^[0-9]{8}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS executives (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  dni VARCHAR(8) NOT NULL UNIQUE CHECK (dni ~ '^[0-9]{8}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_concepts (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  contact_name VARCHAR(180) NOT NULL,
  service_type VARCHAR(180) NOT NULL,
  project_code VARCHAR(60) NOT NULL UNIQUE,
  project_name VARCHAR(220) NOT NULL,
  event_location VARCHAR(250) NOT NULL,
  number_of_dates INTEGER NOT NULL CHECK (number_of_dates > 0),
  commission NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission >= 0 AND commission <= 100),
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN' CHECK (currency IN ('PEN','USD')),
  exchange_rate NUMERIC(10,4),
  producer_id BIGINT NOT NULL REFERENCES producers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  subproducer_id BIGINT REFERENCES subproducers(id) ON UPDATE CASCADE ON DELETE SET NULL,
  executive_id BIGINT NOT NULL REFERENCES executives(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(10,4);

UPDATE projects
SET currency = 'PEN'
WHERE currency IS NULL OR currency NOT IN ('PEN','USD');

UPDATE projects
SET exchange_rate = NULL
WHERE currency = 'PEN';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_currency_check;
ALTER TABLE projects ADD CONSTRAINT projects_currency_check CHECK (currency IN ('PEN','USD'));

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_exchange_rate_check;
ALTER TABLE projects ADD CONSTRAINT projects_exchange_rate_check
  CHECK (
    (currency = 'PEN' AND exchange_rate IS NULL)
    OR
    (currency = 'USD' AND exchange_rate IS NOT NULL AND exchange_rate > 0)
  );

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_commission_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_commission_check
  CHECK (commission >= 0 AND commission <= 100) NOT VALID;

CREATE TABLE IF NOT EXISTS project_event_concepts (
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concept_id BIGINT NOT NULL REFERENCES event_concepts(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, concept_id)
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL,
  concept_id BIGINT NOT NULL,
  producer_id BIGINT NOT NULL REFERENCES producers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  document_type VARCHAR(2) NOT NULL CHECK (document_type IN ('01','03')),
  issuer_ruc VARCHAR(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
  series VARCHAR(4) NOT NULL,
  document_number VARCHAR(20) NOT NULL CHECK (document_number ~ '^[0-9]+
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

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_producer ON projects(producer_id);
CREATE INDEX IF NOT EXISTS idx_projects_subproducer ON projects(subproducer_id);
CREATE INDEX IF NOT EXISTS idx_projects_executive ON projects(executive_id);
ALTER TABLE expense_reports
  ALTER COLUMN document_number TYPE VARCHAR(20)
  USING LPAD(document_number::text, 8, '0');

ALTER TABLE expense_reports DROP CONSTRAINT IF EXISTS expense_reports_document_number_check;
ALTER TABLE expense_reports
  ADD CONSTRAINT expense_reports_document_number_check CHECK (document_number ~ '^[0-9]+
CREATE INDEX IF NOT EXISTS idx_expenses_concept ON expense_reports(concept_id);
CREATE INDEX IF NOT EXISTS idx_expenses_producer ON expense_reports(producer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_validation ON expense_reports(validation_status);

INSERT INTO event_concepts (name) VALUES
  ('PRODUCCIÓN TÉCNICA'),
  ('ESTRUCTURAS Y MOBILIARIO'),
  ('CATERING'),
  ('IMPLEMENTACIONES'),
  ('DISEÑO Y PRODUCCIÓN')
ON CONFLICT (name) DO NOTHING;

COMMIT;
),
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

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_producer ON projects(producer_id);
CREATE INDEX IF NOT EXISTS idx_projects_subproducer ON projects(subproducer_id);
CREATE INDEX IF NOT EXISTS idx_projects_executive ON projects(executive_id);
CREATE INDEX IF NOT EXISTS idx_expenses_project ON expense_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_concept ON expense_reports(concept_id);
CREATE INDEX IF NOT EXISTS idx_expenses_producer ON expense_reports(producer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_validation ON expense_reports(validation_status);

INSERT INTO event_concepts (name) VALUES
  ('PRODUCCIÓN TÉCNICA'),
  ('ESTRUCTURAS Y MOBILIARIO'),
  ('CATERING'),
  ('IMPLEMENTACIONES'),
  ('DISEÑO Y PRODUCCIÓN')
ON CONFLICT (name) DO NOTHING;

COMMIT;
);

CREATE INDEX IF NOT EXISTS idx_expenses_project ON expense_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_concept ON expense_reports(concept_id);
CREATE INDEX IF NOT EXISTS idx_expenses_producer ON expense_reports(producer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_validation ON expense_reports(validation_status);

INSERT INTO event_concepts (name) VALUES
  ('PRODUCCIÓN TÉCNICA'),
  ('ESTRUCTURAS Y MOBILIARIO'),
  ('CATERING'),
  ('IMPLEMENTACIONES'),
  ('DISEÑO Y PRODUCCIÓN')
ON CONFLICT (name) DO NOTHING;

COMMIT;
),
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

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_producer ON projects(producer_id);
CREATE INDEX IF NOT EXISTS idx_projects_subproducer ON projects(subproducer_id);
CREATE INDEX IF NOT EXISTS idx_projects_executive ON projects(executive_id);
CREATE INDEX IF NOT EXISTS idx_expenses_project ON expense_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_concept ON expense_reports(concept_id);
CREATE INDEX IF NOT EXISTS idx_expenses_producer ON expense_reports(producer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_validation ON expense_reports(validation_status);

INSERT INTO event_concepts (name) VALUES
  ('PRODUCCIÓN TÉCNICA'),
  ('ESTRUCTURAS Y MOBILIARIO'),
  ('CATERING'),
  ('IMPLEMENTACIONES'),
  ('DISEÑO Y PRODUCCIÓN')
ON CONFLICT (name) DO NOTHING;

COMMIT;
