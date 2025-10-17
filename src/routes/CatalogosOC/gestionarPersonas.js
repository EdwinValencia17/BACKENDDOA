import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

const isEmpty = (v) => v === undefined || v === null || v === '' || v === '-1';
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function buildWhere(q) {
  const where = [];
  const params = [];
  if (!isEmpty(q.identificacion)) {
    where.push(`p.identificacion ILIKE $${params.length + 1}`);
    params.push(`%${norm(q.identificacion)}%`);
  }
  if (!isEmpty(q.nombre)) {
    where.push(`p.nombre ILIKE $${params.length + 1}`);
    params.push(`%${norm(q.nombre)}%`);
  }
  if (!isEmpty(q.email)) {
    where.push(`p.email ILIKE $${params.length + 1}`);
    params.push(`%${norm(q.email)}%`);
  }
  if (!isEmpty(q.estado)) {
    where.push(`p.estado_registro = $${params.length + 1}`);
    params.push(norm(q.estado));
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** GET /api/personas/buscar */
router.get('/buscar', async (req, res) => {
  try {
    const { page = 1, limit = 20, ...f } = req.query;
    const p = Math.max(1, parseInt(String(page), 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const offset = (p - 1) * l;

    const { whereSql, params } = buildWhere(f);

    const from = ` FROM doa2.persona p `;
    const countSql = `SELECT COUNT(*)::bigint AS total ${from} ${whereSql}`;
    const listSql = `
      SELECT
        p.id_pers, p.identificacion, p.nombre, p.email,
        p.estado_registro, p.idioma, p.gestion_poliza
      ${from}
      ${whereSql}
      ORDER BY p.nombre ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [count, list] = await Promise.all([
      pool.query(countSql, params),
      pool.query(listSql, [...params, l, offset]),
    ]);
    const total = Number(count.rows[0]?.total || 0);

    res.json({ data: list.rows, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
  } catch (err) {
    console.error('[personas/buscar] ERROR', err);
    res.status(500).json({ message: 'Error al buscar personas', detail: err?.message });
  }
});

/** POST /api/personas */
router.post('/', async (req, res) => {
  try {
    const { identificacion, nombre, email, estado_registro = 'A', idioma = 'ES', gestion_poliza = 'N' } = req.body || {};
    if (!identificacion || !nombre) return res.status(400).json({ message: 'Identificación y nombre son obligatorios' });

    const sql = `
      INSERT INTO doa2.persona (identificacion, nombre, email, estado_registro, idioma, gestion_poliza, fecha_creacion, oper_creador)
      VALUES ($1,$2,$3,$4,$5,$6, NOW(), 'api')
      RETURNING id_pers, identificacion, nombre, email, estado_registro, idioma, gestion_poliza
    `;
    const out = await pool.query(sql, [identificacion, nombre, email || null, estado_registro, idioma, gestion_poliza]);
    res.status(201).json(out.rows[0]);
  } catch (err) {
    console.error('[personas/POST] ERROR', err);
    res.status(500).json({ message: 'Error al crear persona', detail: err?.message });
  }
});

/** PUT /api/personas/:id */
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID inválido' });
    const { identificacion, nombre, email, estado_registro, idioma, gestion_poliza } = req.body || {};

    const sql = `
      UPDATE doa2.persona
         SET identificacion = COALESCE($1, identificacion),
             nombre = COALESCE($2, nombre),
             email = COALESCE($3, email),
             estado_registro = COALESCE($4, estado_registro),
             idioma = COALESCE($5, idioma),
             gestion_poliza = COALESCE($6, gestion_poliza),
             fecha_modificacion = NOW(), oper_modifica = 'api'
       WHERE id_pers = $7
      RETURNING id_pers, identificacion, nombre, email, estado_registro, idioma, gestion_poliza
    `;
    const out = await pool.query(sql, [identificacion, nombre, email, estado_registro, idioma, gestion_poliza, id]);
    if (!out.rowCount) return res.status(404).json({ message: 'No encontrado' });
    res.json(out.rows[0]);
  } catch (err) {
    console.error('[personas/PUT] ERROR', err);
    res.status(500).json({ message: 'Error al actualizar persona', detail: err?.message });
  }
});

/** PATCH /api/personas/:id/estado */
router.patch('/:id/estado', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body || {};
    if (!Number.isFinite(id) || !['A','I'].includes(estado)) return res.status(400).json({ message: 'Parámetros inválidos' });

    const sql = `
      UPDATE doa2.persona
         SET estado_registro = $1, fecha_modificacion = NOW(), oper_modifica = 'api'
       WHERE id_pers = $2
    `;
    await pool.query(sql, [estado, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[personas/estado] ERROR', err);
    res.status(500).json({ message: 'Error al cambiar estado', detail: err?.message });
  }
});

/** POST /api/personas/:id/desactivar-permisos
 *  Desactiva todas las filas de AUTORIZADOR de esa persona.
 */
router.post('/:id/desactivar-permisos', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID inválido' });

    const sql = `
      UPDATE doa2.autorizador
         SET estado_registro = 'I', fecha_modificacion = NOW(), oper_modifica = 'api'
       WHERE persona_id_pers = $1
         AND estado_registro = 'A'
    `;
    const out = await pool.query(sql, [id]);
    res.json({ updated: out.rowCount });
  } catch (err) {
    console.error('[personas/desactivar-permisos] ERROR', err);
    res.status(500).json({ message: 'Error al desactivar permisos', detail: err?.message });
  }
});

export default router;
