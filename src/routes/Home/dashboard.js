import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();

function buildFilters(q) {
  const where = [];
  const params = [];

  // fechas
  if (q.from) {
    params.push(q.from);
    where.push(`COALESCE(c.fecha_orden_compra, c.fecha_creacion)::date >= $${params.length}`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`COALESCE(c.fecha_orden_compra, c.fecha_creacion)::date <= $${params.length}`);
  }

  // compañía (acepta id_compania, código_compania o c.compania)
  if (q.compania) {
    params.push(q.compania);
    where.push(`(co.codigo_compania = $${params.length} OR c.compania = $${params.length} OR c.id_compania::text = $${params.length})`);
  }

  // centro de costo (acepta id_ceco o código)
  if (q.centro) {
    params.push(q.centro);
    where.push(`(c.centro_costo_id_ceco::text = $${params.length} OR cc.codigo = $${params.length})`);
  }

  // estado_oc id
  if (q.estado) {
    params.push(Number(q.estado));
    where.push(`c.estado_oc_id_esta = $${params.length}`);
  }

  // prioridad
  if (q.prioridad) {
    params.push(q.prioridad);
    where.push(`c.prioridad_orden = $${params.length}`);
  }

  // solicitante
  if (q.solicitante) {
    params.push(`%${q.solicitante}%`);
    where.push(`c.solicitante ILIKE $${params.length}`);
  }

  // proveedor
  if (q.proveedorNombre) {
    params.push(`%${q.proveedorNombre}%`);
    where.push(`c.nombre_proveedor ILIKE $${params.length}`);
  }
  if (q.proveedorNit) {
    params.push(q.proveedorNit);
    where.push(`c.nit_proveedor = $${params.length}`);
  }

  // solo activos por defecto
  if (q.activos !== '0') where.push(`c.estado_registro = 'A'`);

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSQL, params };
}

// Legacy maps
const LEGACY_CUMPLIDA = [2, 6];
const LEGACY_PROCESO = [1, 5];

/* ========= 1) KPIs + Resumen ========= */
router.get('/api/dashboard/summary', async (req, res) => {
  try {
    const { whereSQL, params } = buildFilters(req.query);

    const kpisSql = `
      SELECT
        COUNT(*)::int AS total_ordenes,
        COALESCE(SUM(c.total_neto),0)::numeric AS total_monto
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.estado_oc e ON e.id_esta = c.estado_oc_id_esta
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL};
    `;

    const estadosSql = `
      SELECT
        e.id_esta,
        e.descripcion,
        COUNT(*)::int AS cantidad
      FROM doa2.cabecera_oc c
      JOIN doa2.estado_oc e ON e.id_esta = c.estado_oc_id_esta
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      GROUP BY e.id_esta, e.descripcion
      ORDER BY e.id_esta;
    `;

    const legacySql = `
      SELECT
        SUM( (c.estado_oc_id_esta = ANY($${params.length+1}))::int )::int AS cumplidas,
        SUM( (c.estado_oc_id_esta = ANY($${params.length+2}))::int )::int AS en_proceso,
        SUM( (
          c.estado_oc_id_esta = 1
          AND c.fecha_sugerida IS NOT NULL
          AND c.fecha_orden_compra IS NULL
          AND c.fecha_sugerida::date < now()::date
        )::int )::int AS atrasadas
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL};
    `;

    const legacyParams = [...params, LEGACY_CUMPLIDA, LEGACY_PROCESO];

    const [kpisR, estadosR, legacyR] = await Promise.all([
      pool.query(kpisSql, params),
      pool.query(estadosSql, params),
      pool.query(legacySql, legacyParams),
    ]);

    const kpis = kpisR.rows[0] || { total_ordenes: 0, total_monto: 0 };
    const estados6 = estadosR.rows;
    const legacy = legacyR.rows[0] || { cumplidas: 0, en_proceso: 0, atrasadas: 0 };

    res.json({ kpis, estados6, legacy });
  } catch (e) {
    console.error('summary error', e);
    res.status(500).json({ error: 'No se pudo obtener el resumen' });
  }
});

/* ========= 2) Series mensuales ========= */
router.get('/api/dashboard/series-mensuales', async (req, res) => {
  try {
    const { whereSQL, params } = buildFilters(req.query);

    const seriesSql = `
      WITH base AS (
        SELECT
          date_trunc('month', COALESCE(c.fecha_orden_compra, c.fecha_creacion))::date AS mes,
          c.estado_oc_id_esta
        FROM doa2.cabecera_oc c
        LEFT JOIN doa2.companias co
          ON co.id_compania = c.id_compania
          OR co.codigo_compania = c.compania
        LEFT JOIN doa2.centro_costo cc
          ON cc.id_ceco = c.centro_costo_id_ceco
          OR cc.codigo = c.centro_costo_id_ceco::text
        ${whereSQL}
      )
      SELECT
        to_char(mes, 'YYYY-MM') AS ym,
        COUNT(*)::int AS emitidas,
        SUM( (estado_oc_id_esta = 2)::int )::int AS aprobadas
      FROM base
      GROUP BY mes
      ORDER BY ym;
    `;

    const montosSql = `
      SELECT
        to_char(date_trunc('month', COALESCE(c.fecha_orden_compra, c.fecha_creacion))::date, 'YYYY-MM') AS ym,
        COALESCE(SUM(c.total_neto),0)::numeric AS monto_total
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      GROUP BY 1
      ORDER BY 1;
    `;

    const [seriesR, montosR] = await Promise.all([
      pool.query(seriesSql, params),
      pool.query(montosSql, params),
    ]);

    res.json({ series: seriesR.rows, montos: montosR.rows });
  } catch (e) {
    console.error('series error', e);
    res.status(500).json({ error: 'No se pudo obtener las series' });
  }
});

/* ========= 3) Top proveedores ========= */
router.get('/api/dashboard/top-proveedores', async (req, res) => {
  try {
    const { whereSQL, params } = buildFilters(req.query);

    const sumSql = `
      SELECT
        c.nombre_proveedor AS proveedor,
        COALESCE(SUM(c.total_neto),0)::numeric AS monto,
        COUNT(*)::int AS cantidad
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      GROUP BY c.nombre_proveedor
      ORDER BY monto DESC NULLS LAST
      LIMIT 5;
    `;

    const countSql = `
      SELECT
        c.nombre_proveedor AS proveedor,
        COUNT(*)::int AS cantidad
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      GROUP BY c.nombre_proveedor
      ORDER BY cantidad DESC NULLS LAST
      LIMIT 10;
    `;

    const [topMontoR, topCountR] = await Promise.all([
      pool.query(sumSql, params),
      pool.query(countSql, params),
    ]);

    res.json({ top5Monto: topMontoR.rows, top10Count: topCountR.rows });
  } catch (e) {
    console.error('top proveedores error', e);
    res.status(500).json({ error: 'No se pudo obtener top proveedores' });
  }
});

/* ========= 4) Estados (6 reales) ========= */
router.get('/api/dashboard/estados-barras', async (req, res) => {
  try {
    const { whereSQL, params } = buildFilters(req.query);

    const sql = `
      SELECT
        e.descripcion AS estado,
        COUNT(*)::int AS cantidad
      FROM doa2.cabecera_oc c
      JOIN doa2.estado_oc e ON e.id_esta = c.estado_oc_id_esta
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      GROUP BY e.descripcion
      ORDER BY e.descripcion;
    `;
    const r = await pool.query(sql, params);
    res.json({ estados: r.rows });
  } catch (e) {
    console.error('estados barras error', e);
    res.status(500).json({ error: 'No se pudo obtener estados' });
  }
});

/* ========= 5) Lista para la tabla ========= */
router.get('/api/dashboard/lista', async (req, res) => {
  try {
    const { whereSQL, params } = buildFilters(req.query);

    // ✅ tipa aquí
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 200;
    const offset = Number(req.query.offset) > 0 ? Number(req.query.offset) : 0;

    const sql = `
      SELECT
        c.id_cabe AS id,
        c.nombre_proveedor AS proveedor,
        COALESCE(cc.descripcion, c.centro_costo_id_ceco::text) AS centrocosto,
        COALESCE(co.nombre_compania, c.compania) AS compania,
        COALESCE(c.fecha_orden_compra, c.fecha_creacion) AS fecha_ref,
        c.total_neto AS monto,
        c.estado_oc_id_esta AS estado_id,
        c.fecha_sugerida,
        c.fecha_orden_compra
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.companias co
        ON co.id_compania = c.id_compania
        OR co.codigo_compania = c.compania
      LEFT JOIN doa2.centro_costo cc
        ON cc.id_ceco = c.centro_costo_id_ceco
        OR cc.codigo = c.centro_costo_id_ceco::text
      ${whereSQL}
      ORDER BY fecha_ref DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2};
    `;

    const r = await pool.query(sql, [...params, limit, offset]);

    const rows = r.rows.map(x => {
      let estado = 'proceso';
      if ([2, 6].includes(x.estado_id)) estado = 'cumplida';
      else if (x.estado_id === 1 && x.fecha_sugerida && !x.fecha_orden_compra && new Date(x.fecha_sugerida) < new Date()) {
        estado = 'atrasada';
      }
      return {
        id: String(x.id),
        proveedor: x.proveedor,
        centroCosto: x.centrocosto,
        compania: x.compania,
        fecha: x.fecha_ref ? new Date(x.fecha_ref).toISOString() : null,
        estado,
        monto: Number(x.monto || 0),
      };
    });

    res.json({ data: rows });
  } catch (e) {
    console.error('lista error', e);
    res.status(500).json({ error: 'No se pudo obtener la lista' });
  }
});


export default router;
