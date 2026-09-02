'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_EMPLOYEE_NAME = process.env.ADMIN_EMPLOYEE_NAME;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não definido. Configure a variável de ambiente antes de iniciar o servidor.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET não definido. Configure a variável de ambiente antes de iniciar o servidor.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD não definido. Configure a variável de ambiente antes de iniciar o servidor.');
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

const HORAS_NORMAIS_MIN = 8 * 60;

function employeeRowToJson(row) {
  return { id: String(row.id), name: row.name, isAdmin: !!row.is_admin, createdAt: row.created_at };
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
    status: row.status || 'aprovado',
    editadoManualmente: row.editado_manualmente,
    editadoEm: row.editado_em,
    updatedAt: row.updated_at,
  };
}

async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function ensureBootstrapAdmin() {
  const bootstrapName = (ADMIN_EMPLOYEE_NAME || '').trim();
  if (!bootstrapName) return;
  try {
    const { rowCount } = await pool.query(
      'UPDATE employees SET is_admin = true WHERE LOWER(name) = LOWER($1) AND is_admin = false',
      [bootstrapName]
    );
    if (rowCount > 0) {
      console.log(`"${bootstrapName}" marcado(a) como gestor(a) via ADMIN_EMPLOYEE_NAME.`);
    }
  } catch (err) {
    console.error('Falha ao aplicar ADMIN_EMPLOYEE_NAME:', err);
  }
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
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'ponto.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: needsSsl, // em produção (Postgres remoto) o app roda atrás de HTTPS no Render
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
  },
}));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.employeeId) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Apenas o gestor pode fazer isso.' });
  }
  next();
}

/* ---------------- Auth ---------------- */

app.get('/api/me', async (req, res, next) => {
  try {
    if (!req.session || !req.session.employeeId) return res.json(null);
    const { rows } = await pool.query('SELECT * FROM employees WHERE id = $1', [req.session.employeeId]);
    if (rows.length === 0) { req.session.employeeId = null; req.session.isAdmin = false; return res.json(null); }
    req.session.isAdmin = !!rows[0].is_admin;
    res.json(employeeRowToJson(rows[0]));
  } catch (err) { next(err); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    const password = (req.body && req.body.password) || '';
    if (!name || !password) return res.status(400).json({ error: 'Informe nome e senha.' });

    const { rows } = await pool.query('SELECT * FROM employees WHERE LOWER(name) = LOWER($1)', [name]);
    const emp = rows[0];
    if (!emp || !emp.password_hash) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

    const ok = await bcrypt.compare(password, emp.password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

    req.session.employeeId = emp.id;
    req.session.isAdmin = !!emp.is_admin;
    res.json(employeeRowToJson(emp));
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res, next) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('ponto.sid');
    res.json({ ok: true });
  });
});

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
    const password = (req.body && req.body.password) || '';
    const adminPassword = (req.body && req.body.adminPassword) || '';
    const isAdminFlag = !!(req.body && req.body.isAdmin);

    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Senha de administrador incorreta.' });
    }
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (name.length > 60) return res.status(400).json({ error: 'Nome muito longo.' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });

    const existing = await pool.query('SELECT * FROM employees WHERE LOWER(name) = LOWER($1)', [name]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Já existe uma pessoa cadastrada com esse nome.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO employees (name, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING *',
      [name, passwordHash, isAdminFlag]
    );
    res.status(201).json(employeeRowToJson(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Já existe uma pessoa cadastrada com esse nome.' });
    }
    next(err);
  }
});

/* ---------------- Records ---------------- */

app.get('/api/records/pending', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, e.name AS employee_name
       FROM records r JOIN employees e ON e.id = r.employee_id
       WHERE r.status = 'pendente'
       ORDER BY r.editado_em DESC NULLS LAST, r.record_date DESC`
    );
    res.json(rows.map(recordRowToJson));
  } catch (err) { next(err); }
});

app.get('/api/records', requireAuth, async (req, res, next) => {
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

app.get('/api/records/today', requireAuth, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date é obrigatório.' });
    const { rows } = await pool.query(
      `SELECT r.*, e.name AS employee_name
       FROM records r JOIN employees e ON e.id = r.employee_id
       WHERE r.employee_id = $1 AND r.record_date = $2`,
      [employeeId, date]
    );
    res.json(rows.length ? recordRowToJson(rows[0]) : null);
  } catch (err) { next(err); }
});

app.post('/api/records/punch', requireAuth, async (req, res, next) => {
  try {
    const employeeId = req.session.employeeId;
    const { date, type, observacao } = req.body || {};
    if (!date || !type) return res.status(400).json({ error: 'date e type são obrigatórios.' });

    const existingQ = await pool.query('SELECT * FROM records WHERE employee_id = $1 AND record_date = $2', [employeeId, date]);
    const existing = existingQ.rows[0] || null;

    if (type === 'entrada') {
      if (existing && existing.entrada) {
        return res.status(409).json({ error: 'Entrada já registrada nesse dia.' });
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
      return res.status(409).json({ error: 'Saída já registrada nesse dia.' });
    }

    const upd = await pool.query(
      `UPDATE records SET ${column} = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [upd.rows[0].id]);
    res.status(200).json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.patch('/api/records/:id/observacao', requireAuth, async (req, res, next) => {
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

app.put('/api/records/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { entrada, inicioIntervalo, fimIntervalo, saida, observacao } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE records SET
         entrada = $1, inicio_intervalo = $2, fim_intervalo = $3, saida = $4,
         observacao = $5, editado_manualmente = true, editado_em = now(), updated_at = now(),
         status = 'pendente'
       WHERE id = $6 RETURNING *`,
      [entrada || null, inicioIntervalo || null, fimIntervalo || null, saida || null, (observacao || '').trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [id]);
    res.json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.post('/api/records/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE records SET status = 'aprovado', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [id]);
    res.json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.post('/api/records/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE records SET status = 'rejeitado', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    const withName = await pool.query('SELECT r.*, e.name AS employee_name FROM records r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1', [id]);
    res.json(recordRowToJson(withName.rows[0]));
  } catch (err) { next(err); }
});

app.get('/api/config', (req, res) => res.json({ horasNormaisMin: HORAS_NORMAIS_MIN }));

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
  .then(ensureBootstrapAdmin)
  .then(() => {
    app.listen(PORT, () => console.log(`Ponto Accerte rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  });
