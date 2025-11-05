// src/modules/dashboard/dashboard.logic.js
// Lógica de backend para el Dashboard DOA (Node + pg)
// — 100% JavaScript, queries parametrizadas y filtros opcionales.

import pool from "../../config/db.js";

/**
 * Normaliza y arma cláusulas WHERE dinámicas a partir de filtros opcionales.
 * @param {Object} f - filtros
 * @param {string} [f.proveedor] - nombre o NIT (parcial)
 * @param {number} [f.centro_costo_id] - id_ceco
 * @param {number} [f.compania_id] - id_compania
 * @param {number} [f.estado_id] - id_esta
 * @param {string[]} [f.meses] - lista de periodos 'YYYYMM'
 * @returns {{sql:string, params:any[]}}
 */
function buildWhere(f = {}) {
  const where = [];
  const params = [];

  if (f.proveedor) {
    params.push(`%${f.proveedor}%`);
    where.push(
      `(coalesce(cab.nombre_proveedor,'') ILIKE $${params.length} OR coalesce(cab.nit_proveedor,'') ILIKE $${params.length})`
    );
  }
  if (f.centro_costo_id) {
    params.push(f.centro_costo_id);
    where.push(`cab.centro_costo_id_ceco = $${params.length}`);
  }
  if (f.compania_id) {
    params.push(f.compania_id);
    where.push(`cab.id_compania = $${params.length}`);
  }
  if (f.estado_id) {
    params.push(f.estado_id);
    where.push(`cab.estado_oc_id_esta = $${params.length}`);
  }
  // Meses (YYYYMM) aplican a fecha_orden_compra si existe; si no, a fecha_creacion.
  if (Array.isArray(f.meses) && f.meses.length) {
    const placeHolders = f.meses.map((p) => {
      const idx = params.push(p);
      return `$${idx}`;
    });
    where.push(
      `to_char(coalesce(cab.fecha_orden_compra, cab.fecha_creacion),'YYYYMM') = ANY(ARRAY[${placeHolders.join(",")}])`
    );
  }

  const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { sql, params };
}

/** Helpers de estado **/
const ESTADOS = {
  APROBADAS: ["APROBADA", "APROBADO"],
  RECHAZADAS: ["RECHAZADA", "RECHAZADO"],
  INICIADAS: ["INICIADA", "INICIADO", "INICIO"],
  PENDIENTE: ["PENDIENTE", "PENDIENTE POR TI"],
};

function estadosToIn(descrs = []) {
  if (!descrs.length) return "('')";
  return `(${descrs.map((d) => `'${d}'`).join(",")})`;
}

/**
 * Tarjetas: Aprobadas / Rechazadas / Iniciadas (sin/ con filtros)
 */
export async function getCardsResumen(filtros = {}) {
  const { sql, params } = buildWhere(filtros);
  const qs = (labels) => `
    SELECT count(*)::int AS qty
    FROM doa2.cabecera_oc cab
    JOIN doa2.estado_oc est ON est.id_esta = cab.estado_oc_id_esta
    ${sql}
    ${sql ? "AND" : "WHERE"} upper(est.descripcion) IN ${estadosToIn(
      labels.map((x) => x.toUpperCase())
    )}
  `;

  const client = await pool.connect();
  try {
    const [ap, re, inis] = await Promise.all([
      client.query(qs(ESTADOS.APROBADAS), params),
      client.query(qs(ESTADOS.RECHAZADAS), params),
      client.query(qs(ESTADOS.INICIADAS), params),
    ]);
    return {
      aprobadas: ap.rows[0]?.qty || 0,
      rechazadas: re.rows[0]?.qty || 0,
      iniciadas: inis.rows[0]?.qty || 0,
    };
  } finally {
    client.release();
  }
}

/**
 * Pendientes por tu aprobación (por persona_id_pers del autorizador)
 */
export async function getPendientesPorTi({ personaId, ...filtros }) {
  if (!personaId) return { pendientes: 0 };
  const { sql, params } = buildWhere(filtros);

  const q = `
    SELECT count(DISTINCT la.cabecera_oc_id_cabe)::int AS pendientes
    FROM doa2.lista_autorizaccion la
    JOIN doa2.autorizador au
      ON au.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau
     AND au.nivel_id_nive = la.nivel_id_nive
     AND au.centro_costo_id_ceco = la.centro_costo_id_ceco
    JOIN doa2.cabecera_oc cab ON cab.id_cabe = la.cabecera_oc_id_cabe
    JOIN doa2.estado_oc est ON est.id_esta = la.estado_oc_id_esta
    ${sql}
    ${sql ? "AND" : "WHERE"} au.persona_id_pers = $${
      params.length + 1
    } AND upper(est.descripcion) IN ${estadosToIn(
    ESTADOS.PENDIENTE.map((s) => s.toUpperCase())
  )}
  `;
  const r = await pool.query(q, [...params, personaId]);
  return r.rows[0] || { pendientes: 0 };
}

/**
 * Gasto mensual por compañía (serie simple)
 */
export async function getGastoMensualPorCompania(filtros = {}) {
  const { sql, params } = buildWhere(filtros);
  const q = `
    SELECT
      cab.id_compania,
      coalesce(com.nombre_compania, cab.compania) AS compania,
      to_char(coalesce(cab.fecha_orden_compra, cab.fecha_creacion),'YYYY-MM') AS periodo,
      sum(coalesce(cab.total_neto,0))::numeric(18,2) AS gasto
    FROM doa2.cabecera_oc cab
    LEFT JOIN doa2.companias com ON com.id_compania = cab.id_compania
    ${sql}
    GROUP BY 1,2,3
    ORDER BY 2,3
  `;
  const r = await pool.query(q, params);
  return r.rows;
}

/**
 * Gasto mensual pivot para comparar Top-N compañías (default 3)
 * Devuelve [{ periodo:'YYYY-MM', series:[{ id_compania, compania, gasto }] }, ...]
 */
export async function getGastoMensualTopNPivot({ top = 3, ...filtros } = {}) {
  const { sql, params } = buildWhere(filtros);

  const q = `
    WITH base AS (
      SELECT
        cab.id_compania,
        coalesce(com.nombre_compania, cab.compania) AS compania,
        to_char(coalesce(cab.fecha_orden_compra, cab.fecha_creacion),'YYYY-MM') AS periodo,
        sum(coalesce(cab.total_neto,0)) AS gasto
      FROM doa2.cabecera_oc cab
      LEFT JOIN doa2.companias com ON com.id_compania = cab.id_compania
      ${sql}
      GROUP BY 1,2,3
    ),
    ranked AS (
      SELECT id_compania, compania, sum(gasto) AS total
      FROM base
      GROUP BY 1,2
      ORDER BY total DESC
    ),
    topc AS (
      SELECT id_compania, compania
      FROM ranked
      ORDER BY total DESC
      LIMIT $${params.length + 1}
    ),
    series AS (
      SELECT b.periodo, b.id_compania, b.compania, b.gasto
      FROM base b
      JOIN topc t USING (id_compania)
    )
    SELECT
      periodo,
      json_agg(
        json_build_object(
          'id_compania', id_compania,
          'compania',   compania,
          'gasto',      round(gasto::numeric, 2)
        )
        ORDER BY id_compania
      ) AS series
    FROM series
    GROUP BY periodo
    ORDER BY periodo
  `;

  const r = await pool.query(q, [...params, top]);
  return r.rows.map(row => ({
    periodo: row.periodo,
    series: row.series.map(s => ({
      id_compania: s.id_compania,
      compania: s.compania,
      gasto: Number(s.gasto),
    })),
  }));
}

/**
 * Resumen Top-N compañías en el rango: total y % participación
 * Devuelve [{ id_compania, compania, total, sharePct }]
 */
export async function getResumenTopNCompanias({ top = 3, ...filtros } = {}) {
  const { sql, params } = buildWhere(filtros);

  const q = `
    WITH base AS (
      SELECT
        cab.id_compania,
        coalesce(com.nombre_compania, cab.compania) AS compania,
        sum(coalesce(cab.total_neto,0)) AS total
      FROM doa2.cabecera_oc cab
      LEFT JOIN doa2.companias com ON com.id_compania = cab.id_compania
      ${sql}
      GROUP BY 1,2
    ),
    topc AS (
      SELECT * FROM base ORDER BY total DESC LIMIT $${params.length + 1}
    ),
    grand AS (
      SELECT sum(total) AS gtotal FROM base
    )
    SELECT
      t.id_compania,
      t.compania,
      round(t.total::numeric, 2)   AS total,
      CASE WHEN g.gtotal = 0 THEN 0
           ELSE round((t.total / g.gtotal) * 100, 2)
      END AS sharePct
    FROM topc t CROSS JOIN grand g
    ORDER BY total DESC
  `;

  const r = await pool.query(q, [...params, top]);
  return r.rows.map(x => ({
    id_compania: x.id_compania,
    compania: x.compania,
    total: Number(x.total),
    sharePct: Number(x.sharepct),
  }));
}

/**
 * Presupuesto vs Ejecutado por Centro de Costo (lista/bar chart)
 * Devuelve por cada CECO la suma de presupuesto del rango de meses y el ejecutado real.
 */
export async function getPresupuestoVsEjecutadoPorCECO(filtros = {}) {
  const hasMeses = Array.isArray(filtros.meses) && filtros.meses.length;
  const { sql, params } = buildWhere({ ...filtros, meses: undefined }); // meses no aplican a CAB en este bloque

  const q = `
    WITH rango AS (
      SELECT unnest($${params.length + 1}::text[]) AS yyyymm
    ),
    pres AS (
      SELECT p.id_ceco,
             sum(coalesce(p.presupuesto_mes,0)) AS presupuesto
      FROM doa2.presup_mes p
      ${hasMeses ? `JOIN rango r ON r.yyyymm = p.periodo_yyyymm` : ``}
      GROUP BY 1
    ),
    ejec AS (
      SELECT cab.centro_costo_id_ceco AS id_ceco,
             sum(coalesce(cab.total_neto,0)) AS ejecutado
      FROM doa2.cabecera_oc cab
      ${sql}
      ${hasMeses ? `${sql ? "AND" : "WHERE"} to_char(coalesce(cab.fecha_orden_compra,cab.fecha_creacion),'YYYYMM') = ANY($${
        params.length + 1
      })` : ""}
      GROUP BY 1
    )
    SELECT c.id_ceco,
           c.descripcion AS centro_costo,
           coalesce(pres.presupuesto,0)::numeric(18,2) AS presupuesto,
           coalesce(ejec.ejecutado,0)::numeric(18,2) AS ejecutado,
           CASE WHEN coalesce(pres.presupuesto,0) = 0 THEN 0
                ELSE round(100*coalesce(ejec.ejecutado,0)/NULLIF(pres.presupuesto,0),2) END AS cumplimiento
    FROM doa2.centro_costo c
    LEFT JOIN pres ON pres.id_ceco = c.id_ceco
    LEFT JOIN ejec ON ejec.id_ceco = c.id_ceco
    WHERE c.estado_registro = 'A'
    ORDER BY cumplimiento DESC NULLS LAST
  `;

  const r = await pool.query(q, [...params, hasMeses ? filtros.meses : []]);
  return r.rows;
}

/**
 * Cumplimiento presupuestal global (tarjeta de % y totales)
 */
export async function getCumplimientoGlobal(filtros = {}) {
  const rows = await getPresupuestoVsEjecutadoPorCECO(filtros);
  const totPres = rows.reduce((a, r) => a + Number(r.presupuesto || 0), 0);
  const totEjec = rows.reduce((a, r) => a + Number(r.ejecutado || 0), 0);
  const pct = totPres === 0 ? 0 : Math.round((totEjec / totPres) * 10000) / 100;
  return { ejecutado: totEjec, presupuesto: totPres, cumplimiento: pct };
}

/**
 * Top proveedores por valor y por #OC
 */
export async function getTopProveedores({ limit = 10, ...filtros } = {}) {
  const { sql, params } = buildWhere(filtros);
  const qValor = `
    SELECT coalesce(cab.nit_proveedor,'') AS nit,
           coalesce(cab.nombre_proveedor,'SIN NOMBRE') AS proveedor,
           sum(coalesce(cab.total_neto,0))::numeric(18,2) AS total_oc
    FROM doa2.cabecera_oc cab
    ${sql}
    GROUP BY 1,2
    ORDER BY total_oc DESC
    LIMIT $${params.length + 1}
  `;
  const qFreq = `
    SELECT coalesce(cab.nit_proveedor,'') AS nit,
           coalesce(cab.nombre_proveedor,'SIN NOMBRE') AS proveedor,
           count(*)::int AS oc
    FROM doa2.cabecera_oc cab
    ${sql}
    GROUP BY 1,2
    ORDER BY oc DESC
    LIMIT $${params.length + 1}
  `;
  const [v, f] = await Promise.all([
    pool.query(qValor, [...params, limit]),
    pool.query(qFreq, [...params, limit]),
  ]);
  return { porValor: v.rows, porFrecuencia: f.rows };
}

/**
 * Totales OC (para la tarjeta: total gastado, cantidad de OC y ticket promedio)
 */
export async function getTotalesOC(filtros = {}) {
  const { sql, params } = buildWhere(filtros);
  const q = `
    SELECT
      coalesce(sum(cab.total_neto),0)::numeric(18,2) AS total,
      count(*)::int AS cantidad,
      CASE WHEN count(*) = 0 THEN 0
           ELSE round(coalesce(sum(cab.total_neto),0) / NULLIF(count(*),0), 2)
      END::numeric(18,2) AS ticket_prom
    FROM doa2.cabecera_oc cab
    ${sql}
  `;
  const r = await pool.query(q, params);
  return r.rows[0] || { total: 0, cantidad: 0, ticket_prom: 0 };
}

/**
 * Totales por compañía (para breakdown opcional)
 */
export async function getTotalesOCPorCompania(filtros = {}) {
  const { sql, params } = buildWhere(filtros);
  const q = `
    SELECT
      cab.id_compania,
      coalesce(com.nombre_compania, cab.compania) AS compania,
      coalesce(sum(cab.total_neto),0)::numeric(18,2) AS total,
      count(*)::int AS cantidad,
      CASE WHEN count(*) = 0 THEN 0
           ELSE round(coalesce(sum(cab.total_neto),0) / NULLIF(count(*),0), 2)
      END::numeric(18,2) AS ticket_prom
    FROM doa2.cabecera_oc cab
    LEFT JOIN doa2.companias com ON com.id_compania = cab.id_compania
    ${sql}
    GROUP BY 1,2
    ORDER BY total DESC
  `;
  const r = await pool.query(q, params);
  return r.rows;
}

/**
 * Dropdowns (filtros): Proveedor, Centro de Costo, Compañía, Estado
 */
export async function getDropdowns() {
  const [proveedores, cecos, cias, estados] = await Promise.all([
    pool.query(`
      SELECT DISTINCT ON (nit_proveedor)
             coalesce(nit_proveedor,'') AS nit,
             coalesce(nombre_proveedor,'SIN NOMBRE') AS nombre
      FROM doa2.cabecera_oc
      WHERE coalesce(nit_proveedor,'') <> '' OR coalesce(nombre_proveedor,'') <> ''
      ORDER BY nit_proveedor, nombre_proveedor
    `),
    pool.query(`
      SELECT id_ceco, descripcion, codigo
      FROM doa2.centro_costo
      WHERE estado_registro = 'A'
      ORDER BY descripcion
    `),
    pool.query(`
      SELECT id_compania, codigo_compania, nombre_compania
      FROM doa2.companias
      WHERE estado_registro = 'A'
      ORDER BY nombre_compania
    `),
    pool.query(`
      SELECT id_esta, descripcion
      FROM doa2.estado_oc
      WHERE estado_registro = 'A'
      ORDER BY descripcion
    `),
  ]);
  return {
    proveedores: proveedores.rows,
    centrosCosto: cecos.rows,
    companias: cias.rows,
    estados: estados.rows,
  };
}

/**
 * Pendientes por área (Compras, Finanzas, Gerente Ops) usando tipo_autorizador
 */
export async function getPendientesPorArea({ personaId, ...filtros } = {}) {
  const { sql, params } = buildWhere(filtros);
  const extra = personaId ? `AND au.persona_id_pers = $${params.length + 1}` : "";
  const q = `
    SELECT UPPER(coalesce(ta.descripcion,'OTROS')) AS area,
           count(DISTINCT la.cabecera_oc_id_cabe)::int AS pendientes
    FROM doa2.lista_autorizaccion la
    JOIN doa2.estado_oc est ON est.id_esta = la.estado_oc_id_esta
    LEFT JOIN doa2.tipo_autorizador ta ON ta.id_tiau = la.tipo_autorizador_id_tiau
    LEFT JOIN doa2.cabecera_oc cab ON cab.id_cabe = la.cabecera_oc_id_cabe
    LEFT JOIN doa2.autorizador au
      ON au.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau
     AND au.nivel_id_nive = la.nivel_id_nive
     AND au.centro_costo_id_ceco = la.centro_costo_id_ceco
    ${sql}
    ${sql ? "AND" : "WHERE"} upper(est.descripcion) LIKE 'PENDIENTE%'
    ${extra}
    GROUP BY 1
    ORDER BY 1
  `;
  const r = await pool.query(q, personaId ? [...params, personaId] : params);
  const map = { COMPRAS: 0, FINANZAS: 0, "GERENTE OPS": 0 };
  for (const row of r.rows) {
    if (map.hasOwnProperty(row.area)) map[row.area] = row.pendientes;
  }
  return { compras: map["COMPRAS"], finanzas: map["FINANZAS"], gerenteOps: map["GERENTE OPS"] };
}

/**
 * Router Express listo para enchufar en /api/dashboard
 */
export function buildDashboardRouter({ express }) {
  const router = express.Router();

  router.get("/cards", async (req, res) => {
    try {
      const data = await getCardsResumen(req.query);
      res.json(data);
    } catch (e) {
      console.error("/cards", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pendientes/mi", async (req, res) => {
    try {
      const personaId = req.query.personaId ? Number(req.query.personaId) : undefined;
      const data = await getPendientesPorTi({ ...req.query, personaId });
      res.json(data);
    } catch (e) {
      console.error("/pendientes/mi", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/gasto-companias", async (req, res) => {
    try {
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getGastoMensualPorCompania({ ...req.query, meses });
      res.json(data);
    } catch (e) {
      console.error("/gasto-companias", e);
      res.status(500).json({ error: e.message });
    }
  });

  // NUEVO: pivot Top-N compañías para comparar por mes
  router.get("/gasto-companias/pivot", async (req, res) => {
    try {
      const top = req.query.top ? Number(req.query.top) : 3;
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getGastoMensualTopNPivot({ ...req.query, meses, top });
      res.json(data);
    } catch (e) {
      console.error("/gasto-companias/pivot", e);
      res.status(500).json({ error: e.message });
    }
  });

  // NUEVO: resumen Top-N (ranking + % de participación)
  router.get("/gasto-companias/resumen", async (req, res) => {
    try {
      const top = req.query.top ? Number(req.query.top) : 3;
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getResumenTopNCompanias({ ...req.query, meses, top });
      res.json(data);
    } catch (e) {
      console.error("/gasto-companias/resumen", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/presupuesto/cecos", async (req, res) => {
    try {
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getPresupuestoVsEjecutadoPorCECO({ ...req.query, meses });
      res.json(data);
    } catch (e) {
      console.error("/presupuesto/cecos", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/presupuesto/cumplimiento", async (req, res) => {
    try {
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getCumplimientoGlobal({ ...req.query, meses });
      res.json(data);
    } catch (e) {
      console.error("/presupuesto/cumplimiento", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/top-proveedores", async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getTopProveedores({ ...req.query, limit, meses });
      res.json(data);
    } catch (e) {
      console.error("/top-proveedores", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/dropdowns", async (_req, res) => {
    try {
      const data = await getDropdowns();
      res.json(data);
    } catch (e) {
      console.error("/dropdowns", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pendientes/area", async (req, res) => {
    try {
      const personaId = req.query.personaId ? Number(req.query.personaId) : undefined;
      const data = await getPendientesPorArea({ ...req.query, personaId });
      res.json(data);
    } catch (e) {
      console.error("/pendientes/area", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Tarjeta: totales OC (valor total, cantidad, ticket promedio)
  router.get("/totales-oc", async (req, res) => {
    try {
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getTotalesOC({ ...req.query, meses });
      res.json(data);
    } catch (e) {
      console.error("/totales-oc", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Breakdown por compañía
  router.get("/totales-oc/companias", async (req, res) => {
    try {
      const meses = req.query.meses ? String(req.query.meses).split(",") : undefined;
      const data = await getTotalesOCPorCompania({ ...req.query, meses });
      res.json(data);
    } catch (e) {
      console.error("/totales-oc/companias", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

/** Ejemplo de uso en tu server
 *
 * import express from 'express';
 * import { buildDashboardRouter } from './src/modules/dashboard/dashboard.logic.js';
 * const app = express();
 * app.use('/api/dashboard', buildDashboardRouter({ express }));
 */
