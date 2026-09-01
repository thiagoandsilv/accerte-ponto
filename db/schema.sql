-- Ponto Certo — schema Postgres
-- Idempotente: seguro rodar em toda inicialização do servidor.

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_name_lower_idx ON employees (LOWER(name));

CREATE TABLE IF NOT EXISTS records (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  record_date DATE NOT NULL,
  entrada TIMESTAMPTZ,
  inicio_intervalo TIMESTAMPTZ,
  fim_intervalo TIMESTAMPTZ,
  saida TIMESTAMPTZ,
  observacao TEXT NOT NULL DEFAULT '',
  editado_manualmente BOOLEAN NOT NULL DEFAULT false,
  editado_em TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, record_date)
);

CREATE INDEX IF NOT EXISTS records_date_idx ON records (record_date);
CREATE INDEX IF NOT EXISTS records_employee_idx ON records (employee_id);
