// src/routes/HistorialDeAutorizacion.js
import express from "express";
import pool from "../config/db.js";
// import authMiddleware from "../middlewares/auth.middleware.js"; // si quieres protegerlo

const router = express.Router();

const T = {
  HIAU:  "doa2.historial_autorizacion",
  PERS:  "doa2.persona",
  LIAU:  "doa2.lista_autorizaccion",
  CABE:  "doa2.cabecera_oc",
  CECO:  "doa2.centro_costo",
  TIAU:  "doa2.tipo_autorizador",
  NIVE:  "doa2.nivel",
  ESTA:  "doa2.estado_oc",
};

const isSet = (v) =>
  v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "-1";
const norm = (v) => (v ?? "").toString().trim();

const SORT_MAP = {
  // por defecto ordenaremos por hiau.fecha_creacion (como en la vieja UI)
  fecha:            "hiau.fecha_creacion",
  numOrden:         "COALESCE(oc.numero_orden_compra, oc_lista.numero_orden_compra)",
  sistema:          "COALESCE(oc.sistema, oc_lista.sistema)",
  tipoAutorizador:  "tiau.codigo",
  centroCosto:      "ceco.codigo",
  nivel:            "nive.nivel",
  estado:           "hiau.estado",
  usuario:          "pers.nombre",
  id:               "COALESCE(oc.id_cabe, oc_lista.id_cabe)",
};

function orderSQL(sortField = "fecha", sortOrder = "DESC") {
  const col = SORT_MAP[sortField] || SORT_MAP.fecha;
  const dir = String(sortOrder).toUpperCase() === "ASC" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, COALESCE(oc.id_cabe, oc_lista.id_cabe) DESC`;
}

/**
 * buildWhere emula el DECODE de la consulta legacy:
 * - si el parámetro viene vacío / "-1": NO filtra
 * - estado se compara textual (APROBADO/RECHAZADO/…)
 * - fecha se compara contra hiau.fecha_creacion::date
 * - nombreAuto hace ILIKE %...%
 */
function buildWhere(q = {}) {
  const where = [];
  const params = [];

  const isSet = (v) =>
    v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "-1";
  const norm = (v) => (v ?? "").toString().trim();

  if (isSet(q.numeroOc)) {
    params.push(norm(q.numeroOc));
    where.push(`COALESCE(oc.numero_orden_compra, oc_lista.numero_orden_compra) = $${params.length}`);
  }
  if (isSet(q.numeroSol)) {
    params.push(norm(q.numeroSol));
    where.push(`COALESCE(oc.numero_solicitud, oc_lista.numero_solicitud) = $${params.length}`);
  }
  if (isSet(q.sistema)) {
    params.push(norm(q.sistema));
    where.push(`COALESCE(oc.sistema, oc_lista.sistema) = $${params.length}`);
  }
  if (isSet(q.tipoAutorizador)) {
    params.push(parseInt(q.tipoAutorizador, 10));
    where.push(`tiau.id_tiau = $${params.length}`);
  }
  if (isSet(q.centroCosto)) {
    params.push(parseInt(q.centroCosto, 10));
    where.push(`ceco.id_ceco = $${params.length}`);
  }
  if (isSet(q.nivel)) {
    params.push(parseInt(q.nivel, 10));
    where.push(`nive.id_nive = $${params.length}`);
  }
  if (isSet(q.estado)) {
    // Acepta 'APROBADO', 'APROBADA', 'RECHAZADO', etc.
    const v = norm(q.estado).toUpperCase();
    const canon =
      v.startsWith('APROBAD') ? 'APROBADO' :
      v.startsWith('RECHAZAD') ? 'RECHAZADO' :
      v.startsWith('ANULAD') ? 'ANULADO' :
      v.startsWith('PENDIENT') ? 'PENDIENTE' : v;
    params.push(canon);
    where.push(`UPPER(hiau.estado) = $${params.length}`);
  }

  // === NUEVO: rango de fechas ===
  // prioridad:
  //   - si llega 'fecha' (igualdad), úsala tal cual (compatibilidad legacy)
  //   - si llegan dateFrom/dateTo, aplica BETWEEN; si llega solo uno, aplica >= o <=
  if (isSet(q.fecha)) {
    params.push(norm(q.fecha)); // YYYY-MM-DD
    where.push(`hiau.fecha_creacion::date = $${params.length}::date`);
  } else {
    const hasFrom = isSet(q.dateFrom);
    const hasTo   = isSet(q.dateTo);
    if (hasFrom && hasTo) {
      params.push(norm(q.dateFrom), norm(q.dateTo));
      where.push(`hiau.fecha_creacion::date BETWEEN $${params.length-1}::date AND $${params.length}::date`);
    } else if (hasFrom) {
      params.push(norm(q.dateFrom));
      where.push(`hiau.fecha_creacion::date >= $${params.length}::date`);
    } else if (hasTo) {
      params.push(norm(q.dateTo));
      where.push(`hiau.fecha_creacion::date <= $${params.length}::date`);
    }
  }

  if (isSet(q.nombreAuto)) {
    params.push(`%${norm(q.nombreAuto)}%`);
    where.push(`pers.nombre ILIKE $${params.length}`);
  }

  return {
    whereSQL: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

/**
 * GET /api/historial-autorizacion
 * Query:
 *  - page=1&pageSize=10
 *  - sortField=[fecha|numOrden|sistema|tipoAutorizador|centroCosto|nivel|estado|usuario|id]
 *  - sortOrder=ASC|DESC
 *  - numeroOc, numeroSol, sistema, tipoAutorizador, centroCosto, nivel, estado, fecha(YYYY-MM-DD), nombreAuto
 */
// router.get("/", authMiddleware, async (req, res) => {
router.get("/", async (req, res) => {
  const {
    page = 1,
    pageSize = 10,
    sortField = "fecha",
    sortOrder = "DESC",
    numeroOc,
    numeroSol,
    sistema,
    tipoAutorizador,
    centroCosto,
    nivel,
    estado,
    fecha,       // igualdad (legacy)
    dateFrom,    // NUEVO: rango
    dateTo,      // NUEVO: rango
    nombreAuto,
  } = req.query;

  const paging = {
    limit: Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 500),
    offset: Math.max((parseInt(page, 10) || 1) - 1, 0),
  };

  let client;
  try {
    const { whereSQL, params } = buildWhere({
      numeroOc,
      numeroSol,
      sistema,
      tipoAutorizador,
      centroCosto,
      nivel,
      estado,
      fecha,
      dateFrom,   // pasa al builder
      dateTo,     // pasa al builder
      nombreAuto,
    });

    client = await pool.connect();

    const baseFrom = `
      FROM ${T.HIAU} hiau
      INNER JOIN ${T.PERS} pers ON pers.identificacion = hiau.oper_creador
      LEFT JOIN ${T.CABE} oc       ON hiau.cabecera_oc_id_cabe = oc.id_cabe
      LEFT JOIN ${T.LIAU} liau     ON hiau.lista_autorizaccion_id_liau = liau.id_liau
      LEFT JOIN ${T.CABE} oc_lista ON liau.cabecera_oc_id_cabe = oc_lista.id_cabe
      LEFT JOIN ${T.CECO} ceco     ON liau.centro_costo_id_ceco = ceco.id_ceco
      LEFT JOIN ${T.TIAU} tiau     ON liau.tipo_autorizador_id_tiau = tiau.id_tiau
      LEFT JOIN ${T.NIVE} nive     ON liau.nivel_id_nive = nive.id_nive
    `;

    const countSQL = `SELECT COUNT(*) AS total ${baseFrom} ${whereSQL}`;
    const { rows: countRows } = await client.query(countSQL, params);
    const total = parseInt(countRows[0]?.total || "0", 10);

    const dataSQL = `
      SELECT
        COALESCE(oc.id_cabe, oc_lista.id_cabe)                          AS idcabeceraoc,
        COALESCE(oc.numero_orden_compra, oc_lista.numero_orden_compra)  AS numorden,
        COALESCE(oc.numero_solicitud, oc_lista.numero_solicitud)        AS numerosolicitud,
        COALESCE(oc.sistema, oc_lista.sistema)                           AS sistema,

        liau.id_liau                                                     AS idliau,

        ceco.id_ceco                                                     AS idcentrocosto,
        ceco.codigo                                                      AS nombrecentrocosto,
        tiau.id_tiau                                                     AS idtipoautorizador,
        tiau.codigo                                                      AS nombretipoautorizador,
        nive.id_nive                                                     AS idnivel,
        nive.nivel                                                       AS nombrenivel,

        hiau.estado                                                      AS nombreestado,
        CASE WHEN hiau.estado = 'APROBADO'
             THEN TO_CHAR(hiau.fecha_modificacion, 'YYYY-MM-DD')
             ELSE ' ' END                                               AS fechaautorizadorstr,

        hiau.observacion                                                 AS observaciones,
        TO_CHAR(hiau.fecha_creacion, 'YYYY-MM-DD')                       AS fechaordenstring,
        pers.nombre                                                      AS nombreusuario
      ${baseFrom}
      ${whereSQL}
      ${orderSQL(sortField, sortOrder)}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const dataParams = [...params, paging.limit, paging.offset * paging.limit];
    const { rows } = await client.query(dataSQL, dataParams);

    res.json({
      page: parseInt(page, 10) || 1,
      pageSize: paging.limit,
      total,
      rows,
    });
  } catch (err) {
    console.error("[GET /historial-autorizacion] error:", err);
    res.status(500).json({
      error: "No se pudo consultar el historial de autorizaciones",
      detalle: err.message,
    });
  } finally {
    client?.release?.();
  }
});

/**
 * Combos: exactamente las listas que usaba la vieja vista (código visible).
 * GET /api/historial-autorizacion/combos
 */
router.get("/combos", async (_req, res) => {
  let client;
  try {
    client = await pool.connect();
    const [tiau, ceco, nive, esta, sistemas] = await Promise.all([
      client.query(`SELECT id_tiau AS value, codigo AS label FROM ${T.TIAU} WHERE estado_registro='A' ORDER BY codigo`),
      client.query(`SELECT id_ceco AS value, codigo AS label FROM ${T.CECO} WHERE estado_registro='A' ORDER BY codigo`),
      client.query(`SELECT id_nive AS value, nivel  AS label FROM ${T.NIVE} WHERE estado_registro='A' ORDER BY nivel`),
      client.query(`SELECT descripcion AS label FROM ${T.ESTA} WHERE estado_registro='A' ORDER BY id_esta`),
      client.query(`SELECT DISTINCT sistema AS label FROM ${T.CABE} WHERE COALESCE(sistema,'')<>'' ORDER BY 1 LIMIT 200`),
    ]);

    res.json({
      tiposAutorizador: tiau.rows,
      centrosCosto: ceco.rows,
      niveles: nive.rows,
      estados: esta.rows.map((r) => ({ value: r.label, label: r.label })), // el filtro legacy compara por descripción textual
      sistemas: sistemas.rows.map((r) => ({ value: r.label, label: r.label })),
    });
  } catch (err) {
    console.error("[GET /historial-autorizacion/combos] error:", err);
    res.status(500).json({ error: "No se pudieron obtener los combos", detalle: err.message });
  } finally {
    client?.release?.();
  }
});

export default router;
