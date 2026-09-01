'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não definido. Configure a variável de ambiente antes de iniciar o servidor.');
  process.exit(1);
}

// Render Postgres exige SSL; um Postgres local (ex: 127.0.0.1) normalmente não usa.
const needsSsl = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

const PUNCH_FIELDS = {
  intervaloIni: 'inicio_intervalo',
  intervaloFim: 'fim_intervalo',
  saida: 'saida',
};

function employeeRowToJson(row) {
  return { id: String(row.id), name: row.name, createdAt: row.created_at };
}

function recordRowToJson(row) {
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    employeeName: row.employee_name || undefined,
    date: row.record_date instanceof Date ? row.record_date.toISOString().slice(0, 10) : row.record_date,
    entrada: row.entrada,
    inicioIntervalo: row.inicio_intervalo,
    fimIntervalo: row.fim_intervalo,
    saida: row.saida,
    observacao: row.observacao || '',
    editadoManualmente: row.editado_manualmente,
    editadoEm: row.editado_em,
    updatedAt: row.updated_at,
  };
}

async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function waitForDb(retries, delayMs) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`Aguardando o banco de dados (tentativa ${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Não foi possível conectar ao banco de dados.');
}

const app = express();
app.use(express.json());

/* ---------------- Employees ---------------- */

app.get('/api/employees', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM employees ORDER BY name ASC');
    res.json(rows.map(employeeRowToJson));
  } catch (err) { next(err); }
});

app.post('/api/employees', async (req, res, next) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (name.length > 60) return res.status(400).json({ error: 'Nome muito longo.' });

    const existing = await pool.query('SELECT * FROM employees WHERE LOWER(name) = LOWER($1)', [name]);
    if (existing.rows.length > 0) {
      return res.status(200).json(employeeRowToJson(existing.rows[0]));
    }
    const { rows } = await pool.query(
      'INSERT INTO employees (name) VALUES ($1) RETURNING *',
      [name]
    );
    res.status(201).json(employeeRowToJson(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      const existing = await pool.query('SELECT * FROM employees WHERE LOWER(name) = LOWER($1)', [(req.body.name || '').trim()]);
      if (existing.rows.length > 0) return res.status(200).json(employeeRowToJson(existing.rows[0]));
    }
    next(err);
  }
});

/* ---------------- Records ---------------- */

app.get('/api/records', async (req, res, next) => {
  try {
    const { start, end, employeeId } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios (YYYY-MM-DD).' });

    const params = [start, end];
    let where = 'r.record_date BETWEEN $1 AND $2';
    if (employeeId) {
      params.push(employeeId);
      where += ` AND r.employee_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT r.*, e.name AS employee_name
       FROM records r JOIN employees e ON e.id = r.employee_id
       WHERE ${where}
       ORDER BY r.record_date DESC, e.name ASC`,
      params
    );
    res.json(rows.map(recordRowToJson));
  } catch (err) { next(err); }
});

app.get('/api/records/today', async (req, res, next) => {
  try {
    const { employeeId, date } = req.query;
    if (!employeeId || !date) return res.status(400).json({ error: 'employeeId e date são obrigatórios.' });
    const { rows } = await pool.query(
      `SELECT r.*, e.name AS employee_name
       FROM records r JOIN employees e ON e.id = r.employee_id
       WHERE r.employee_id = $1 AND r.record_date = $2`,
      [employeeId, date]
    );
    res.json(rows.length ? recordRowToJson(rows[0]) : null);
  } catch (err) { next(err); }
});

app.post('/api/records/punch', async (req, res, next) => {
  try {
    const { employeeId, date, type, observacao } = req.body || {};
    if (!employeeId || !date || !type) return res.status(400).json({ error: 'employeeId, date e type são obrigatórios.' });

    const emp = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId]);
    if (emp.rows.length === 0) return res.status(404).json({ error: 'Funcionário não encontrado.' });

    const existingQ = await pool.query('SELECT * FROM records WHERE employee_id = $1 AND record_date = $2', [employeeId, date]);
    const existing = existingQ.rows[0] || null;

    if (type === 'entrada') {
      if (existing && existing.entrada) {
        return res.status(409).json({ error: 'Entrada já registrada hoje.' });
      }
      let row;
      if (!existing) {
        const ins = await pool.query(
          `INSERT INTO records (employee_id, record_date, entrada, observacao)
           VALUES ($1, $2, now(), $3) RETURNING *`,
          [employeeId, date, (observacao || '').trim()]
        );
        row = ins.rows[0];
      } else {
        const upd = await pool.query(
          `UPDATE records SET entrada = now(), updated_at = now() WHERE id = $1 RETURNING *`,
          [existing.id]
        );
        row = upd.rows[0];
      }
      const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [row.id]);
      return res.status(200).json(recordRowToJson(withName.rows[0]));
    }

    const column = PUNCH_FIELDS[type];
    if (!column) return res.status(400).json({ error: 'Tipo de registro inválido.' });
    if (!existing || !existing.entrada) return res.status(409).json({ error: 'Registre a entrada antes.' });

    if (type === 'intervaloIni' && (existing.inicio_intervalo || existing.saida)) {
      return res.status(409).json({ error: 'Intervalo já iniciado ou jornada encerrada.' });
    }
    if (type === 'intervaloFim' && (!existing.inicio_intervalo || existing.fim_intervalo)) {
      return res.status(409).json({ error: 'Intervalo ainda não foi iniciado ou já foi finalizado.' });
    }
    if (type === 'saida' && existing.saida) {
      return res.status(409).json({ error: 'Saída já registrada hoje.' });
    }

    const upd = await pool.query(
      `UPDATE records SET ${column} = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [upd.rows[0].id]);
    res.status(200).json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.patch('/api/records/:id/observacao', async (req, res, next) => {
  try {
    const { id } = req.params;
    const observacao = (req.body && req.body.observacao) || '';
    const { rows } = await pool.query(
      `UPDATE records SET observacao = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [observacao.trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [id]);
    res.json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.put('/api/records/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { entrada, inicioIntervalo, fimIntervalo, saida, observacao } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE records SET
         entrada = $1, inicio_intervalo = $2, fim_intervalo = $3, saida = $4,
         observacao = $5, editado_manualmente = true, editado_em = now(), updated_at = now()
       WHERE id = $6 RETURNING *`,
      [entrada || null, inicioIntervalo || null, fimIntervalo || null, saida || null, (observacao || '').trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [id]);
    res.json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

waitForDb(20, 1500)
  .then(runMigrations)
  .then(() => {
    app.listen(PORT, () => console.log(`Ponto Certo rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  });
