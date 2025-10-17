// src/routes/Admin/GestionPermisoTemporales.js
import express from 'express';
import pool from '../../config/db.js'; // ajusta la ruta si fuera necesario

const router = express.Router();

/* ========================= Helpers ========================= */
const isEmpty = v => v === undefined || v === null || v === '' || v === '-1';
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const day  = d => (d && `${d}`.slice(0,10)) || null;

function overlapWhere(alias = 'a', bIni = '$1', bFin = '$2') {
  // Traslape de rangos: [ini, fin] cruza con [bIni, bFin]  <=>  NOT (fin < bIni OR ini > bFin)
  return `NOT (${alias}.fecha_fin_permiso < ${bIni} OR ${alias}.fecha_inicio_permiso > ${bFin})`;
}

/* ========================= GET: Personas =========================
   Lista para poblar ambas tablas (principal/secundaria), con búsqueda y estado
=================================================================== */
router.get('/permisos-temporales/personas', async (req, res) => {
  const { q = '', estado = 'A', page = 1, limit = 50 } = req.query;
  const off = (Number(page) - 1) * Number(limit);

  const isEmpty = (v) => v === undefined || v === null || v === '' || v === '-1';
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const terms = isEmpty(q) ? '' : norm(q);
  const params = [];
  let where = `1=1`;

  if (!isEmpty(estado)) {
    params.push(estado);
    where += ` AND p.estado_registro = $${params.length}`;
  }
  if (!isEmpty(terms)) {
    params.push(`%${terms.toUpperCase()}%`);
    where += ` AND (
      UPPER(p.identificacion) LIKE $${params.length}
      OR UPPER(p.nombre) LIKE $${params.length}
      OR UPPER(COALESCE(p.email,'')) LIKE $${params.length}
    )`;
  }

  const sql = `
    WITH filtered AS (
      SELECT p.id_pers, p.identificacion, p.nombre, p.email,
             p.fecha_creacion, p.oper_creador, p.fecha_modificacion, p.oper_modifica,
             p.estado_registro, p.idioma, p.gestion_poliza
      FROM doa2.persona p
      WHERE ${where}
    )
    SELECT *
    FROM filtered
    ORDER BY nombre ASC
    LIMIT ${Number(limit)} OFFSET ${off};
  `;
  const countSql = `SELECT COUNT(1) AS total FROM doa2.persona p WHERE ${where};`;

  try {
    const [{ rows }, countRes] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params),
    ]);
    const total = Number(countRes.rows[0]?.total || 0);
    res.json({ ok: true, data: rows, page: Number(page), pageSize: Number(limit), total });
  } catch (err) {
    console.error('Error personas:', err);
    res.status(500).json({ ok: false, message: 'Error listando personas' });
  }
});

/* ========================= GET: Autorizadores por persona ========================= */
router.get('/permisos-temporales/autorizadores', async (req, res) => {
  const personaId = Number(req.query.personaId || 0);
  if (!personaId) return res.status(400).json({ ok:false, message:'personaId requerido' });

  const sql = `
    SELECT a.id_auto, a.estado_registro, a.tipo_autorizador_id_tiau, a.nivel_id_nive, a.centro_costo_id_ceco,
           a.persona_id_pers, a.temporal, a.fecha_inicio_temporal, a.fecha_fin_temporal,
           a.fecha_creacion, a.oper_creador, a.fecha_modificacion, a.oper_modifica
    FROM doa2.autorizador a
    WHERE a.persona_id_pers = $1
    ORDER BY a.estado_registro DESC, a.temporal DESC, a.fecha_creacion DESC;
  `;
  try {
    const { rows } = await pool.query(sql, [personaId]);
    res.json({ ok:true, rows });
  } catch (err) {
    console.error('Error autorizadores:', err);
    res.status(500).json({ ok:false, message:'Error consultando autorizadores' });
  }
});

/* ========================= GET: Historial ========================= */
router.get('/permisos-temporales/historial', async (req, res) => {
  const {
    principalId = 0,
    secundarioId = 0,
    desde = '',
    hasta = '',
    limit = 50,
    page = 1
  } = req.query;

  const off = (Number(page) - 1) * Number(limit);
  const params = [];
  let where = '1=1';

  if (Number(principalId)) {
    params.push(Number(principalId));
    where += ` AND h.usuario_principal = $${params.length}`;
  }
  if (Number(secundarioId)) {
    params.push(Number(secundarioId));
    where += ` AND h.usuario_secundario = $${params.length}`;
  }
  if (!isEmpty(desde) && !isEmpty(hasta)) {
    params.push(desde, hasta);
    where += ` AND ${overlapWhere('h', `$${params.length-1}`, `$${params.length}`)}`;
  }

  const sql = `
    SELECT h.id_hipa, h.usuario_principal, h.usuario_secundario, h.autorizador,
           h.fecha_inicio_permiso, h.fecha_fin_permiso, h.tipo_log_permiso,
           h.estado_registro, h.fecha_creacion, h.fecha_modificacion, h.oper_creador, h.oper_modifica
    FROM doa2.historial_permisos_autorizador h
    WHERE ${where}
    ORDER BY h.fecha_creacion DESC
    LIMIT ${Number(limit)} OFFSET ${off};
  `;

  try {
    const { rows } = await pool.query(sql, params);
    res.json({ ok:true, rows, page:Number(page), limit:Number(limit) });
  } catch (err) {
    console.error('Error historial:', err);
    res.status(500).json({ ok:false, message:'Error listando historial' });
  }
});

/* ========================= POST: Asignar Permisos Temporales =========================
   Clona roles activos del principal hacia el secundario como temporales en [fechaInicio, fechaFin]
======================================================================================= */
router.post('/permisos-temporales/asignar', async (req, res) => {
  const {
    principalId,
    secundarioId,
    fechaInicio,  // 'YYYY-MM-DD' o ISO
    fechaFin,     // 'YYYY-MM-DD' o ISO
    operador,     // código del usuario que ejecuta
  } = req.body || {};

  try {
    // ===== Validaciones básicas =====
    if (isEmpty(principalId) || isEmpty(secundarioId)) {
      return res.status(400).json({ ok:false, message:'principalId y secundarioId son requeridos' });
    }
    if (Number(principalId) === Number(secundarioId)) {
      return res.status(400).json({ ok:false, message:'El principal y el secundario deben ser distintos' });
    }
    if (isEmpty(fechaInicio) || isEmpty(fechaFin)) {
      return res.status(400).json({ ok:false, message:'Fechas requeridas' });
    }
    const ini = new Date(fechaInicio);
    const fin = new Date(fechaFin);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime())) {
      return res.status(400).json({ ok:false, message:'Fechas inválidas' });
    }
    if (ini > fin) {
      return res.status(400).json({ ok:false, message:'La fecha de inicio no puede ser mayor a la final' });
    }

    await pool.query('BEGIN');

    // 1) Verificar existencia de ambos usuarios
    const personasSQL = `
      SELECT id_pers, estado_registro FROM doa2.persona WHERE id_pers = ANY($1::int[]);
    `;
    const { rows: personas } = await pool.query(personasSQL, [[Number(principalId), Number(secundarioId)]]);
    const pMap = new Map(personas.map(r => [Number(r.id_pers), r]));
    if (!pMap.get(Number(principalId))) throw new Error('Principal no existe');
    if (!pMap.get(Number(secundarioId))) throw new Error('Secundario no existe');

    // 2) Traer roles activos del principal
    const qRolesPrincipal = `
      SELECT id_auto, tipo_autorizador_id_tiau AS tiau, nivel_id_nive AS nive, centro_costo_id_ceco AS ceco
      FROM doa2.autorizador
      WHERE estado_registro = 'A' AND persona_id_pers = $1;
    `;
    const { rows: rolesPrincipal } = await pool.query(qRolesPrincipal, [Number(principalId)]);
    if (!rolesPrincipal.length) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ ok:false, message:'El principal no tiene roles activos para delegar' });
    }

    // 3) Validar conflictos de temporales en secundario
    const conflictSQL = `
      SELECT 1
      FROM doa2.autorizador a
      WHERE a.persona_id_pers = $1
        AND a.estado_registro = 'A'
        AND a.temporal = 'S'
        AND a.tipo_autorizador_id_tiau = $2
        AND a.nivel_id_nive = $3
        AND a.centro_costo_id_ceco = $4
        AND ${overlapWhere('a', '$5', '$6')}
      LIMIT 1;
    `;

    // 4) Insertar/Clonar + log
    const insertAutoSQL = `
      INSERT INTO doa2.autorizador (
        fecha_creacion, oper_creador, estado_registro,
        tipo_autorizador_id_tiau, nivel_id_nive, centro_costo_id_ceco,
        persona_id_pers, temporal, fecha_inicio_temporal, fecha_fin_temporal
      )
      VALUES (NOW(), $1, 'A', $2, $3, $4, $5, 'S', $6, $7)
      RETURNING id_auto;
    `;

    const insertHistSQL = `
      INSERT INTO doa2.historial_permisos_autorizador (
        usuario_principal, usuario_secundario, autorizador,
        fecha_inicio_permiso, fecha_fin_permiso, tipo_log_permiso,
        estado_registro, fecha_creacion, oper_creador
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'A', NOW(), $7)
      RETURNING id_hipa;
    `;

    let creados = 0;
    const creadosDetalle = [];

    for (const r of rolesPrincipal) {
      const paramsConflict = [
        Number(secundarioId),
        Number(r.tiau),
        Number(r.nive),
        Number(r.ceco),
        ini.toISOString().slice(0,10),
        fin.toISOString().slice(0,10),
      ];
      const { rows: conf } = await pool.query(conflictSQL, paramsConflict);
      if (conf.length) {
        // Ya existe un temporal traslapado igual; saltamos
        continue;
      }

      const paramsInsertAuto = [
        norm(isEmpty(operador) ? '' : operador), // $1 oper_creador
        Number(r.tiau),                           // $2
        Number(r.nive),                           // $3
        Number(r.ceco),                           // $4
        Number(secundarioId),                     // $5
        ini.toISOString().slice(0,10),           // $6
        fin.toISOString().slice(0,10),           // $7
      ];
      const { rows: newAuto } = await pool.query(insertAutoSQL, paramsInsertAuto);
      const idAutoNuevo = newAuto[0]?.id_auto;

      const paramsHist = [
        Number(principalId),
        Number(secundarioId),
        Number(idAutoNuevo),
        ini.toISOString().slice(0,10),
        fin.toISOString().slice(0,10),
        'ASIGNACION',
        norm(isEmpty(operador) ? '' : operador)
      ];
      const { rows: newHist } = await pool.query(insertHistSQL, paramsHist);

      creados++;
      creadosDetalle.push({
        tiau: r.tiau, nive: r.nive, ceco: r.ceco,
        id_autorizador: idAutoNuevo,
        id_historial: newHist[0]?.id_hipa
      });
    }

    await pool.query('COMMIT');

    return res.json({
      ok: true,
      message: creados
        ? `Se crearon ${creados} permisos temporales para el secundario`
        : 'No se crearon permisos (existían temporales traslapados)',
      creados,
      detalle: creadosDetalle
    });

  } catch (err) {
    console.error('Error asignar permisos temporales:', err);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ ok:false, message:'Error asignando permisos temporales' });
  }
});

export default router;
