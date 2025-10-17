// src/routes/Admin/HistorialDepermisos.js
import express from 'express';
import pool from '../../config/db.js'; // 👈 tu pool

const router = express.Router();

/* ========= Helpers ========= */
const isEmpty = (v) =>
  v === undefined || v === null || `${v}`.trim() === '' || `${v}`.trim() === '-1';

const toYMD = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/* ============================================================================
   GET /api/admin/historial-permisos
   Filtros + paginado server-side (prime friendly: data, page, pageSize, total)
   Query params:
     qPrincipal, qSecundario, tiau, ceco, nive, tipoLog,
     desde (YYYY-MM-DD), hasta (YYYY-MM-DD), fecha (YYYY-MM-DD),
     page (1..n), limit
============================================================================ */
router.get('/admin/historial-permisos', async (req, res) => {
  try {
    const {
      qPrincipal = '',
      qSecundario = '',
      tiau = '-1',
      ceco = '-1',
      nive = '-1',
      tipoLog = '',
      desde = '',
      hasta = '',
      fecha = '',
      page = 1,
      limit = 50,
    } = req.query;

    const off = (Number(page) - 1) * Number(limit);

    const params = [];
    let where = '1=1';

    // principal (persona p1)
    if (!isEmpty(qPrincipal)) {
      params.push(`%${String(qPrincipal).toUpperCase()}%`);
      where += ` AND (
        UPPER(p1.identificacion) LIKE $${params.length}
        OR UPPER(p1.nombre)       LIKE $${params.length}
        OR UPPER(COALESCE(p1.email,'')) LIKE $${params.length}
      )`;
    }

    // secundario (persona p2)
    if (!isEmpty(qSecundario)) {
      params.push(`%${String(qSecundario).toUpperCase()}%`);
      where += ` AND (
        UPPER(p2.identificacion) LIKE $${params.length}
        OR UPPER(p2.nombre)       LIKE $${params.length}
        OR UPPER(COALESCE(p2.email,'')) LIKE $${params.length}
      )`;
    }

    // tipo de log
    if (!isEmpty(tipoLog)) {
      params.push(String(tipoLog).toUpperCase());
      where += ` AND UPPER(h.tipo_log_permiso) = $${params.length}`;
    }

    // catálogos
    if (!isEmpty(tiau)) {
      params.push(Number(tiau));
      where += ` AND a.tipo_autorizador_id_tiau = $${params.length}`;
    }
    if (!isEmpty(ceco)) {
      params.push(Number(ceco));
      where += ` AND a.centro_costo_id_ceco = $${params.length}`;
    }
    if (!isEmpty(nive)) {
      params.push(Number(nive));
      where += ` AND a.nivel_id_nive = $${params.length}`;
    }

    // rango de fechas (en campos de historial)
    if (!isEmpty(desde) && !isEmpty(hasta)) {
      params.push(toYMD(desde));
      params.push(toYMD(hasta));
      where += ` AND h.fecha_inicio_permiso >= $${params.length - 1} AND h.fecha_fin_permiso <= $${params.length}`;
    } else if (!isEmpty(desde)) {
      params.push(toYMD(desde));
      where += ` AND h.fecha_inicio_permiso >= $${params.length}`;
    } else if (!isEmpty(hasta)) {
      params.push(toYMD(hasta));
      where += ` AND h.fecha_fin_permiso <= $${params.length}`;
    }

    // fecha puntual (dentro del rango)
    if (!isEmpty(fecha)) {
      params.push(toYMD(fecha));
      where += ` AND h.fecha_inicio_permiso <= $${params.length}`;
      params.push(toYMD(fecha));
      where += ` AND h.fecha_fin_permiso   >= $${params.length}`;
    }

    const baseFrom = `
      FROM doa2.historial_permisos_autorizador h
      JOIN doa2.autorizador a           ON a.id_auto = h.autorizador
      JOIN doa2.persona p1              ON p1.id_pers = h.usuario_principal
      JOIN doa2.persona p2              ON p2.id_pers = h.usuario_secundario
      LEFT JOIN doa2.tipo_autorizador t ON t.id_tiau = a.tipo_autorizador_id_tiau
      LEFT JOIN doa2.centro_costo c     ON c.id_ceco = a.centro_costo_id_ceco
      LEFT JOIN doa2.nivel n            ON n.id_nive = a.nivel_id_nive
      WHERE ${where}
    `;

    const countSql = `SELECT COUNT(1) AS total ${baseFrom};`;

    const selectSql = `
      SELECT
        h.id_hipa,
        h.usuario_principal,
        p1.identificacion AS identificacion_principal,
        p1.nombre         AS nombre_usuario_principal,
        h.usuario_secundario,
        p2.identificacion AS identificacion_secundario,
        p2.nombre         AS nombre_usuario_secundario,
        h.autorizador,
        a.tipo_autorizador_id_tiau AS tiau,
        t.codigo                     AS nombre_tipo_autorizador,
        a.centro_costo_id_ceco       AS ceco,
        c.codigo                     AS nombre_centro_costo,
        a.nivel_id_nive              AS nive,
        n.nivel                      AS nombre_nivel,
        h.fecha_inicio_permiso,
        h.fecha_fin_permiso,
        h.tipo_log_permiso,
        h.estado_registro,
        h.fecha_creacion,
        h.fecha_modificacion,
        h.oper_creador,
        h.oper_modifica
      ${baseFrom}
      ORDER BY h.fecha_creacion DESC
      LIMIT ${Number(limit)} OFFSET ${off};
    `;

    const [countRes, listRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(selectSql, params),
    ]);

    const total = Number(countRes.rows?.[0]?.total || 0);
    res.json({
      ok: true,
      data: listRes.rows,
      page: Number(page),
      pageSize: Number(limit),
      total,
    });
  } catch (err) {
    console.error('GET /admin/historial-permisos error:', err);
    res.status(500).json({ ok: false, message: 'Error listando historial' });
  }
});

/* ================== Catálogos (combos) ================== */

router.get('/admin/historial-permisos/tipos-autorizador', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_tiau, codigo, descripcion, estado_registro
      FROM doa2.tipo_autorizador
      WHERE estado_registro = 'A'
      ORDER BY codigo ASC
    `);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Error listando tipos autorizador' });
  }
});

router.get('/admin/historial-permisos/centros-costo', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_ceco, codigo, descripcion, estado_registro
      FROM doa2.centro_costo
      WHERE estado_registro = 'A'
      ORDER BY codigo ASC
    `);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Error listando centros de costo' });
  }
});

router.get('/admin/historial-permisos/niveles', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_nive, nivel, descripcion, estado_registro
      FROM doa2.nivel
      WHERE estado_registro = 'A'
      ORDER BY nivel ASC
    `);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Error listando niveles' });
  }
});

export default router;
