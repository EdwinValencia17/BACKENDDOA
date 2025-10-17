// src/routes/Admin/OrdenesCompra.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* ===== helpers ===== */
const isEmpty = (v) =>
  v === undefined || v === null || `${v}`.trim() === "" || `${v}`.trim() === "-1";

const toYMD = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

/* ============================================================================
   GET /api/autorizaciones-solicitante/admin/oc
   Lista OC activas + pendientes (UNION ALL) con filtros + paginado
============================================================================ */
router.get("/admin/oc", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      sortField = "fecha", // fecha | total | oc | solicitud
      sortOrder = "DESC",
      q = "",
      qOC = "",
      qSol = "",
      proveedor = "",
      ceco = "-1",
      compania = "",
      estado = "-1",
      prioridad = "-1",
      sistema = "-1",
      fechaDesde = "",
      fechaHasta = "",
    } = req.query;

    const off = (Number(page) - 1) * Number(limit);
    const params = [];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    const baseActivas = `
      SELECT
        'ACTIVA'                AS fuente,
        c.id_cabe               AS id_cabecera,
        c.numero_solicitud      AS numero_solicitud,
        c.numero_orden_compra   AS numero_oc,
        c.fecha_orden_compra    AS fecha_oc,
        c.nombre_proveedor      AS proveedor,
        c.total_neto::float8    AS total_neto,
        c.estado_oc_id_esta     AS id_estado,
        e.descripcion           AS estado,
        c.centro_costo_id_ceco  AS id_ceco,
        NULL::text              AS ceco_txt,
        c.compania              AS compania,
        c.prioridad_orden       AS prioridad,
        c.sistema               AS sistema,
        c.solicitante           AS solicitante,
        c.fecha_creacion        AS fecha_creacion
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.estado_oc e ON e.id_esta = c.estado_oc_id_esta
    `;

    const basePend = `
      SELECT
        'PENDIENTE'             AS fuente,
        p.id_cabepen            AS id_cabecera,
        p.numero_solicitud      AS numero_solicitud,
        p.numero_orden_compra   AS numero_oc,
        p.fecha_orden_compra    AS fecha_oc,
        p.nombre_proveedor      AS proveedor,
        p.total_neto::float8    AS total_neto,
        p.estado_oc_id_esta     AS id_estado,
        e.descripcion           AS estado,
        NULL::bigint            AS id_ceco,
        COALESCE(p.centrocosto,'')::text AS ceco_txt,
        p.compania              AS compania,
        p.prioridad_orden       AS prioridad,
        p.sistema               AS sistema,
        p.solicitante           AS solicitante,
        p.fecha_creacion        AS fecha_creacion
      FROM doa2.cabecera_oc_pendientes p
      LEFT JOIN doa2.estado_oc e ON e.id_esta = p.estado_oc_id_esta
    `;

    const wrapUnion = `
      FROM (
        ${baseActivas}
        UNION ALL
        ${basePend}
      ) oc
    `;

    const wh = [];
    if (!isEmpty(q)) {
      const p = `%${String(q).toUpperCase()}%`;
      const p1 = push(p),
        p2 = push(p),
        p3 = push(p);
      wh.push(`(
        UPPER(oc.proveedor) LIKE ${p1}
        OR UPPER(oc.solicitante) LIKE ${p2}
        OR UPPER(COALESCE(oc.numero_oc,'')) LIKE ${p3}
      )`);
    }
    if (!isEmpty(qOC)) wh.push(`COALESCE(oc.numero_oc,'') ILIKE ${push(`%${qOC}%`)}`);
    if (!isEmpty(qSol)) wh.push(`COALESCE(oc.numero_solicitud,'') ILIKE ${push(`%${qSol}%`)}`);
    if (!isEmpty(proveedor))
      wh.push(`UPPER(oc.proveedor) LIKE ${push(`%${String(proveedor).toUpperCase()}%`)}`);
    if (!isEmpty(ceco)) wh.push(`COALESCE(oc.id_ceco::text, oc.ceco_txt) = ${push(String(ceco))}`);
    if (!isEmpty(compania)) wh.push(`COALESCE(oc.compania,'') = ${push(String(compania))}`);
    if (!isEmpty(estado)) wh.push(`oc.id_estado::text = ${push(String(estado))}`);
    if (!isEmpty(prioridad)) wh.push(`COALESCE(oc.prioridad,'') = ${push(String(prioridad))}`);
    if (!isEmpty(sistema)) wh.push(`COALESCE(oc.sistema,'') = ${push(String(sistema))}`);

    if (!isEmpty(fechaDesde))
      wh.push(`COALESCE(oc.fecha_oc, oc.fecha_creacion) >= ${push(toYMD(fechaDesde))}`);
    if (!isEmpty(fechaHasta))
      wh.push(`COALESCE(oc.fecha_oc, oc.fecha_creacion) <= ${push(toYMD(fechaHasta))}`);

    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const orderMap = {
      fecha: "COALESCE(oc.fecha_oc, oc.fecha_creacion)",
      total: "oc.total_neto",
      oc: "oc.numero_oc",
      solicitud: "oc.numero_solicitud",
    };
    const orderCol = orderMap[sortField] || orderMap.fecha;
    const orderDir = String(sortOrder).toUpperCase() === "ASC" ? "ASC" : "DESC";

    const countSql = `SELECT COUNT(1) AS total ${wrapUnion} ${WHERE};`;
    const pageSql = `
      SELECT *
      ${wrapUnion}
      ${WHERE}
      ORDER BY ${orderCol} ${orderDir}, oc.id_cabecera ${orderDir}
      LIMIT ${Number(limit)} OFFSET ${off};
    `;

    const [countRes, listRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(pageSql, params),
    ]);

    const total = Number(countRes.rows?.[0]?.total || 0);
    res.json({ ok: true, data: listRes.rows, page: Number(page), pageSize: Number(limit), total });
  } catch (err) {
    console.error("GET /admin/oc error:", err);
    res.status(500).json({ ok: false, message: "Error listando OC" });
  }
});

/* ============================================================================
   GET /api/autorizaciones-solicitante/admin/oc/:fuente/:id/detalle
============================================================================ */
router.get("/admin/oc/:fuente/:id/detalle", async (req, res) => {
  try {
    const { fuente, id } = req.params;
    let sql;
    if (fuente === "ACTIVA") {
      sql = `
        SELECT
          d.id_deta,
          d.cabecera_oc_id_cabe,
          d.item_x_categoria_id_itca,
          d.referencia,
          d.descripcion_referencia,
          d.fecha_entrega,
          d.unidad_medida,
          d.cantidad::float8                AS cantidad,
          d.valor_unidad::float8            AS valor_unidad,
          d.iva::float8                     AS iva,
          d.valor_iva::float8               AS valor_iva,
          d.descuento::float8               AS descuento,
          d.valor_descuento::float8         AS valor_descuento,
          d.valor_sin_iva_descuento::float8 AS valor_sin_iva_descuento,
          d.valor_total::float8             AS valor_total
        FROM doa2.detalle_oc d
        WHERE d.cabecera_oc_id_cabe = $1
        ORDER BY d.id_deta ASC
      `;
    } else {
      sql = `
        SELECT
          d.id_deta_pendiente,
          d.id_cabepen,
          d.referencia,
          d.descripcion_referencia,
          d.fecha_entrega,
          d.unidad_medida,
          d.cantidad::float8                AS cantidad,
          d.valor_unidad::float8            AS valor_unidad,
          d.iva::float8                     AS iva,
          d.valor_iva::float8               AS valor_iva,
          d.descuento::float8               AS descuento,
          d.valor_descuento::float8         AS valor_descuento,
          d.valor_sin_iva_descuento::float8 AS valor_sin_iva_descuento,
          d.valor_total::float8             AS valor_total
        FROM doa2.detalle_oc_pendiente d
        WHERE d.id_cabepen = $1
        ORDER BY d.id_deta_pendiente ASC
      `;
    }
    const { rows } = await pool.query(sql, [Number(id)]);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET detalle OC error:", err);
    res.status(500).json({ ok: false, message: "Error obteniendo detalle" });
  }
});

/* ============================================================================
   GET /api/autorizaciones-solicitante/admin/oc/:fuente/:id/flujo
   - Grupo “DUEÑO CC” detectado por DESCRIPCION de NIVEL
   - Personas SOLO las que APROBARON (historial.estado ILIKE 'APROBA%')
============================================================================ */
router.get("/admin/oc/:fuente/:id/flujo", async (req, res) => {
 const id = Number(req.params.id);
   if (!Number.isFinite(id)) return res.status(400).json({ ok:false, message:'ID inválido' });
 
   try {
     const sql = `
       SELECT
         la.id_liau                                   AS id,
         ta.codigo                                     AS "tipoAutorizador",
         n.nivel                                       AS "nivel",
         cc.codigo                                     AS "centroCosto",
         eo.descripcion                                 AS "estado",
         mr.descripcion                                 AS "motivoRechazo",
         la.observacion                                 AS "observaciones",
         asg.personas_asignadas                         AS "personas"
       FROM doa2.lista_autorizaccion la
       LEFT JOIN doa2.tipo_autorizador ta ON ta.id_tiau = la.tipo_autorizador_id_tiau
       LEFT JOIN doa2.nivel n             ON n.id_nive  = la.nivel_id_nive
       LEFT JOIN doa2.centro_costo cc     ON cc.id_ceco = la.centro_costo_id_ceco
       LEFT JOIN doa2.estado_oc eo        ON eo.id_esta = la.estado_oc_id_esta
       LEFT JOIN doa2.motivo_rechazo mr   ON mr.id_more = la.motivo_rechazo_id_more
 
       /* Personas asignadas (soporta tipo_autorizador NULL) */
       LEFT JOIN LATERAL (
         WITH pers AS (
           SELECT DISTINCT jsonb_build_object(
             'id',     p.id_pers,
             'nombre', NULLIF(TRIM(p.nombre), ''),
             'email',  NULLIF(TRIM(p.email),  '')
           ) AS pj
           FROM doa2.autorizador a
           JOIN doa2.persona p ON p.id_pers = a.persona_id_pers AND p.estado_registro='A'
           WHERE a.estado_registro='A'
             AND a.nivel_id_nive = la.nivel_id_nive
             AND (
                  (a.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau)
               OR (a.tipo_autorizador_id_tiau IS NULL AND la.tipo_autorizador_id_tiau IS NULL)
             )
             AND (a.centro_costo_id_ceco IS NULL OR a.centro_costo_id_ceco = la.centro_costo_id_ceco)
             AND (
                  COALESCE(a.temporal,'N')='N'
               OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
             )
         )
         SELECT COALESCE(
           (SELECT json_agg(pj ORDER BY pj->>'nombre', pj->>'email') FROM pers),
           '[]'::json
         ) AS personas_asignadas
       ) asg ON TRUE
 
       WHERE la.cabecera_oc_id_cabe = $1::bigint
         AND la.estado_registro='A'
 
       /* Orden:
          0: DUENO CC
          1: sin tipo (—) distintos a DUENO CC
          2: con tipo y nivel numérico asc
          3: resto
       */
       ORDER BY
         CASE
           WHEN UPPER(COALESCE(n.nivel,'')) = 'DUENO CC' THEN 0
           WHEN ta.id_tiau IS NULL AND UPPER(COALESCE(n.nivel,'')) <> 'DUENO CC' THEN 1
           WHEN ta.id_tiau IS NOT NULL AND COALESCE(n.nivel,'') ~ '^[0-9]+$' THEN 2
           ELSE 3
         END,
         CASE
           WHEN COALESCE(n.nivel,'') ~ '^[0-9]+$' THEN (n.nivel)::int
           ELSE 9999
         END,
         ta.codigo NULLS LAST,
         la.id_liau
     `;
     const { rows } = await pool.query(sql, [id]);
     res.json(rows);
   } catch (err) {
     console.error('GET /detalles-bandeja-autorizacion/ordenes/:id/flujo', err);
     res.status(500).json({ ok:false, message:'Error obteniendo flujo' });
   }
 });


/* ===== catálogos ===== */
router.get("/admin/oc/estados", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_esta, descripcion
      FROM doa2.estado_oc
      WHERE estado_registro = 'A'
      ORDER BY descripcion ASC
    `);
    res.json({ ok: true, rows });
  } catch {
    res.status(500).json({ ok: false, message: "Error listando estados" });
  }
});

router.get("/admin/oc/centros-costo", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_ceco, codigo, descripcion
      FROM doa2.centro_costo
      WHERE estado_registro = 'A'
      ORDER BY codigo ASC
    `);
    res.json({ ok: true, rows });
  } catch {
    res.status(500).json({ ok: false, message: "Error listando centros de costo" });
  }
});

router.get("/admin/oc/companias", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_compania, codigo_compania, nombre_compania
      FROM doa2.companias
      WHERE estado_registro = 'A'
      ORDER BY nombre_compania ASC
    `);
    res.json({ ok: true, rows });
  } catch {
    res.status(500).json({ ok: false, message: "Error listando compañías" });
  }
});

router.get("/admin/oc/prioridades", (_req, res) =>
  res.json({
    ok: true,
    rows: [
      { code: "G", label: "URGENTE" },
      { code: "I", label: "INVENTARIO" },
      { code: "N", label: "NORMAL" },
      { code: "P", label: "PREVENTIVO" },
      { code: "U", label: "PRIORITARIO" },
    ],
  })
);

export default router;
