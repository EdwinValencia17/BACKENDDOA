// src/routes/Gestiones/GestionarParametros.js
// ✅ Rutas para gestionar "parametros".
//    100% alineado con tu front (GET lista paginada con filtros, GET por id, PUT actualizar valor).
//    Columnas usadas (tal cual BD): id_para, parametro, valor, fecha_creacion, oper_creador,
//                                   fecha_modificacion, oper_modifica, estado_registro

import express from 'express';
import pool from '../../config/db.js';
// Si quieres proteger con JWT, descomenta:
// import authMiddleware from '../../middlewares/auth.middleware.js';

const router = express.Router();

/* -------------------- helpers -------------------- */

// Mapea snake_case (BD) -> camelCase (DTO del front)
function mapRow(r) {
  return {
    idPara: r.id_para,
    parametro: r.parametro,
    valor: r.valor,
    fechaCreacion: r.fecha_creacion ? r.fecha_creacion.toISOString?.() ?? r.fecha_creacion : null,
    operCreador: r.oper_creador ?? null,
    fechaModificacion: r.fecha_modificacion ? r.fecha_modificacion.toISOString?.() ?? r.fecha_modificacion : null,
    operModifica: r.oper_modifica ?? null,
    estadoRegistro: r.estado_registro ?? null,
  };
}

// Aplica filtros LIKE de manera segura
function makeFilterWhere({ q, nombre, valor }) {
  const where = [];
  const params = [];

  // compatibilidad: si viene q, se busca en parametro y valor
  if (q && q.trim() !== '') {
    params.push(`%${q.trim()}%`);
    params.push(`%${q.trim()}%`);
    where.push(`(parametro ILIKE $${params.length - 1} OR valor ILIKE $${params.length})`);
  }
  if (nombre && nombre.trim() !== '') {
    params.push(`%${nombre.trim()}%`);
    where.push(`parametro ILIKE $${params.length}`);
  }
  if (valor && valor.trim() !== '') {
    params.push(`%${valor.trim()}%`);
    where.push(`valor ILIKE $${params.length}`);
  }

  // Mantén sólo registros activos por defecto (si lo deseas)
  // params.push('A');
  // where.push(`estado_registro = $${params.length}`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

/* -------------------- GET /gestiones/parametros (lista paginada) -------------------- */
// Ejemplo: /api/gestiones/parametros?q=foo&nombre=abc&valor=123&page=1&pageSize=10
router.get('/gestiones/parametros', /* authMiddleware, */ async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page ?? '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize ?? '10', 10), 1), 100);
    const q = (req.query.q ?? '').toString();
    const nombre = (req.query.nombre ?? '').toString();
    const valor = (req.query.valor ?? '').toString();

    const { whereSql, params } = makeFilterWhere({ q, nombre, valor });

    // total
    const countSql = `SELECT COUNT(*)::int AS total FROM doa2.parametros ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows[0]?.total ?? 0;

    // data
    const offset = (page - 1) * pageSize;
    const dataSql = `
      SELECT
        id_para, parametro, valor,
        fecha_creacion, oper_creador,
        fecha_modificacion, oper_modifica,
        estado_registro
      FROM doa2.parametros
      ${whereSql}
      ORDER BY id_para ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const { rows } = await pool.query(dataSql, [...params, pageSize, offset]);

    res.json({
      page,
      pageSize,
      total,
      data: rows.map(mapRow),
    });
  } catch (e) {
    console.error('❌ listar parametros:', e);
    res.status(500).json({ error: 'No se pudo listar parámetros' });
  }
});

/* -------------------- GET /gestiones/parametros/:idPara (detallar) -------------------- */
router.get('/gestiones/parametros/:idPara', /* authMiddleware, */ async (req, res) => {
  try {
    const idPara = parseInt(req.params.idPara, 10);
    if (!Number.isFinite(idPara)) {
      return res.status(400).json({ error: 'idPara inválido' });
    }

    const { rows } = await pool.query(
      `SELECT id_para, parametro, valor, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica, estado_registro
         FROM doa2.parametros
        WHERE id_para = $1`,
      [idPara]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parámetro no encontrado' });

    res.json(mapRow(rows[0]));
  } catch (e) {
    console.error('❌ obtener parametro:', e);
    res.status(500).json({ error: 'No se pudo obtener el parámetro' });
  }
});

/* -------------------- PUT /gestiones/parametros/:idPara (actualizar valor) -------------------- */
// Body esperado: { valor: string, operModifica?: string }
router.put('/gestiones/parametros/:idPara', /* authMiddleware, */ async (req, res) => {
  try {
    const idPara = parseInt(req.params.idPara, 10);
    if (!Number.isFinite(idPara)) {
      return res.status(400).json({ error: 'idPara inválido' });
    }

    const { valor, operModifica } = req.body ?? {};
    if (typeof valor !== 'string' || !valor.length) {
      return res.status(400).json({ error: 'valor requerido' });
    }

    const params = [valor, operModifica ?? null, idPara];
    const { rowCount } = await pool.query(
      `UPDATE doa2.parametros
          SET valor = $1,
              oper_modifica = $2,
              fecha_modificacion = now()
        WHERE id_para = $3`,
      params
    );

    // Traemos el registro actualizado para devolvérselo al front
    let parametro;
    if (rowCount > 0) {
      const { rows } = await pool.query(
        `SELECT id_para, parametro, valor, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica, estado_registro
           FROM doa2.parametros
          WHERE id_para = $1`,
        [idPara]
      );
      parametro = rows[0] ? mapRow(rows[0]) : undefined;
    }

    res.json({ ok: true, updated: rowCount, parametro });
  } catch (e) {
    console.error('❌ actualizar valor parametro:', e);
    res.status(500).json({ ok: false, updated: 0, message: 'No se pudo actualizar el parámetro' });
  }
});

export default router;
