// 💜 Backend — Bandeja del Autorizador (ESM, esquema real)

import express from "express";
import pool from "../../config/db.js";
import authMiddleware from "../../middlewares/auth.middleware.js";
import { updatePo } from "../services/WsActualizacionEstadoQAD.js";
import { getBasePaths, openAdjunto } from "../services/AdjuntosOC.js";

const router = express.Router();

const T = {
  LIAU: "doa2.lista_autorizaccion",
  CABE: "doa2.cabecera_oc",
  ESTA: "doa2.estado_oc",
  CECO: "doa2.centro_costo",
  MORE: "doa2.motivo_rechazo",
  TIAU: "doa2.tipo_autorizador",
  NIVE: "doa2.nivel",
  PERS: "doa2.persona",
  TPOC: "doa2.tipo_poliza_x_oc",
  TPOL: "doa2.tipo_poliza",
  HAUT: "doa2.historial_autorizacion",
  PARAM: "doa2.parametros",
  ARAD: "doa2.archivos_adjuntos",
};

// IDs “clásicos”
const ID_INICIADO = 1;
const ID_APROBADO = 2;
const ID_RECHAZADO = 3;
const ID_MAS_DATOS = 5;

const SORT_MAP = {
  fechaOC: "c0.fecha_orden_compra",
  numeroOc: "c0.numero_orden_compra",
  estado: "c0.estado_oc_id_esta", // orden por cabecera (rápido)
  empresa: "c0.nombre_empresa",
  centroCosto: "c0.centro_costo_id_ceco",
  prioridad: "c0.prioridad_orden",
  sistema: "c0.sistema",
  id: "c0.id_cabe",
  valor: "c0.total_neto",
};

const isSet = (v) =>
  v !== undefined &&
  v !== null &&
  String(v).trim() !== "" &&
  String(v).trim() !== "-1";
const norm = (v) => (v ?? "").toString().trim();
const ints = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => parseInt(x, 10))
    .filter(Number.isFinite);

function orderSQL(sortField, sortOrder) {
  const col = SORT_MAP[sortField] || SORT_MAP.fechaOC;
  const dir =
    String(sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, c0.id_cabe DESC`;
}

// Helpers auth
const isAdminUser = (u = {}) => {
  const role = String(u.role || "").toUpperCase();
  const roles = (u.roles || []).map((r) => String(r).toUpperCase());
  return role === "ADMIN" || roles.includes("ADMIN");
};

async function resolvePersonaId(client, u = {}) {
  const direct = parseInt(u.personaId ?? u.id_persona ?? u.idPersona, 10);
  if (Number.isFinite(direct) && direct > 0) return direct;

  if (u.identificacion) {
    const { rows } = await client.query(
      `SELECT id_pers FROM ${T.PERS} WHERE identificacion=$1 LIMIT 1`,
      [String(u.identificacion).trim()]
    );
    if (rows[0]?.id_pers) return parseInt(rows[0].id_pers, 10);
  }

  if (u.email) {
    const { rows } = await client.query(
      `SELECT id_pers FROM ${T.PERS} WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [String(u.email).trim()]
    );
    if (rows[0]?.id_pers) return parseInt(rows[0].id_pers, 10);
  }

  return null;
}

// WHERE de cabecera (rápido)
function buildWhere(q = {}) {
  const where = [], params = [];

  if (isSet(q.numeroSolicitud)) {
    params.push(`%${norm(q.numeroSolicitud)}%`);
    where.push(`c0.numero_solicitud ILIKE $${params.length}`);
  }
  if (isSet(q.numeroOc)) {
    params.push(`%${norm(q.numeroOc)}%`);
    where.push(`c0.numero_orden_compra ILIKE $${params.length}`);
  }
  if (isSet(q.proveedor)) {
    params.push(`%${norm(q.proveedor)}%`);
    where.push(`(c0.nit_proveedor ILIKE $${params.length} OR c0.nombre_proveedor ILIKE $${params.length})`);
  }

  // 🔧 Compañía: código (MP/BM), nombre o NIT; y cruzamos con tabla companias
  if (isSet(q.compania)) {
    const comp = `%${norm(q.compania)}%`;
    params.push(comp, comp, comp, comp);
    where.push(`(
       TRIM(c0.compania) ILIKE $${params.length-3} OR
       COALESCE(c0.nombre_empresa,'') ILIKE $${params.length-2} OR
       COALESCE(c0.nit_empresa,'')    ILIKE $${params.length-1} OR
       EXISTS (
         SELECT 1 FROM doa2.companias co
          WHERE co.codigo_compania = TRIM(c0.compania)
            AND COALESCE(co.nombre_compania,'') ILIKE $${params.length}
       )
    )`);
  }

  if (isSet(q.sistema)) {
    params.push(norm(q.sistema));
    where.push(`c0.sistema = $${params.length}`);
  }
  if (isSet(q.prioridad)) {
    params.push(norm(q.prioridad));
    where.push(`c0.prioridad_orden = $${params.length}`);
  }

  // Estado (cabecera)
  if (isSet(q.estado)) {
    params.push(parseInt(q.estado, 10));
    where.push(`c0.estado_oc_id_esta = $${params.length}`);
  }

  // Centro de costo (cabecera)
  if (isSet(q.centroCosto)) {
    params.push(parseInt(q.centroCosto, 10));
    where.push(`c0.centro_costo_id_ceco = $${params.length}`);
  }

  // Rango de fechas
  if (isSet(q.fechaInicio) && isSet(q.fechaFinal)) {
    params.push(q.fechaInicio, q.fechaFinal);
    where.push(`c0.fecha_orden_compra BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (isSet(q.fechaInicio) || isSet(q.fechaFinal)) {
    throw new Error("Debes enviar fechaInicio y fechaFinal juntas.");
  }

  // autorizadores[] → se filtra en EXISTS (LIAU). Aquí no.

  return {
    whereSQL: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

async function resolveOperModifica(client, user) {
  const u = user || {};
  if (isSet(u.identificacion)) return norm(u.identificacion);
  const personaId = [u.personaId, u.id_persona, u.idPersona].find((x) =>
    Number.isFinite(parseInt(x, 10))
  );
  if (personaId) {
    const { rows } = await client.query(
      `SELECT identificacion FROM ${T.PERS} WHERE id_pers=$1 LIMIT 1`,
      [parseInt(personaId, 10)]
    );
    if (rows[0]?.identificacion) return norm(rows[0].identificacion);
  }
  if (isSet(u.globalId)) return norm(u.globalId);
  if (isSet(u.username)) return norm(u.username);
  if (isSet(u.id)) return norm(u.id);
  return "system";
}

async function getEstadoDesc(client, idEsta) {
  const { rows } = await client.query(
    `SELECT descripcion FROM ${T.ESTA} WHERE id_esta=$1`,
    [idEsta]
  );
  return rows[0]?.descripcion || String(idEsta);
}
async function getMotivoDesc(client, idMore) {
  if (!Number.isFinite(parseInt(idMore, 10))) return null;
  const { rows } = await client.query(
    `SELECT descripcion FROM ${T.MORE} WHERE id_more=$1`,
    [parseInt(idMore, 10)]
  );
  return rows[0]?.descripcion || null;
}
async function insertHistorial(
  client,
  { estado, observacion, motivo, liauId, ocId, oper }
) {
  await client.query(
    `INSERT INTO ${T.HAUT}
       (estado, observacion, motivo_rechazo, fecha_creacion, oper_creador,
        fecha_modificacion, oper_modifica, estado_registro,
        lista_autorizaccion_id_liau, cabecera_oc_id_cabe)
     VALUES ($1,$2,$3, NOW(), $4, NOW(), $4, 'A', $5, $6)`,
    [estado, observacion ?? null, motivo ?? null, oper, liauId, ocId]
  );
}

// Bogotá ddMMyy
function ddMMyyBogota(now = new Date()) {
  const tz = "America/Bogota";
  const d = new Intl.DateTimeFormat("es-CO", { timeZone: tz, day: "2-digit" }).format(now);
  const m = new Intl.DateTimeFormat("es-CO", { timeZone: tz, month: "2-digit" }).format(now);
  const y = new Intl.DateTimeFormat("es-CO", { timeZone: tz, year: "2-digit" }).format(now);
  return `${d}${m}${y}`;
}

async function getParametro(client, nombre) {
  const { rows } = await client.query(
    `SELECT valor FROM ${T.PARAM} WHERE parametro=$1 AND estado_registro='A' LIMIT 1`,
    [nombre]
  );
  return rows[0]?.valor ?? null;
}

/* ============= WS QAD + blindaje ============= */

function mapSistemaToDominio(sistema) {
  const s = String(sistema ?? "").trim();
  if (/^\d+$/.test(s)) return s; // 15/25
  if (s.toUpperCase() === "MP") return "15";
  if (s.toUpperCase() === "BM") return "25";
  return "15";
}

async function enviarEstadoAQADConBlindaje({ client, ocId, estadoQAD }) {
  const { rows: meta } = await client.query(
    `SELECT numero_orden_compra, sistema FROM ${T.CABE} WHERE id_cabe=$1 LIMIT 1`,
    [ocId]
  );
  if (!meta.length) return { ok: false, error: `OC id=${ocId} no existe` };

  const numeroOc = String(meta[0].numero_orden_compra || "").trim();
  const dominio = mapSistemaToDominio(meta[0].sistema);

  const { rows: rejAny } = await client.query(
    `SELECT 1
       FROM ${T.HAUT}
      WHERE cabecera_oc_id_cabe = $1
        AND UPPER(estado) LIKE 'RECHAZ%'
      LIMIT 1`,
    [ocId]
  );
  const huboRechazo = rejAny.length > 0;

  if (estadoQAD === "C" && huboRechazo) {
    console.info(`[QAD] SKIP UpdatePo(C): OC ${numeroOc} ya tuvo rechazo histórico.`);
    return { ok: true, skipped: true, reason: "rechazo_historico", numeroOc, dominio };
  }
  if (estadoQAD === "X" && huboRechazo) {
    console.info(`[QAD] SKIP UpdatePo(X): OC ${numeroOc} ya rechazada.`);
    return { ok: true, skipped: true, reason: "ya_rechazada", numeroOc, dominio };
  }

  const fecha = ddMMyyBogota(new Date());
  const desestado = estadoQAD === "X" ? "REJECTED" : estadoQAD === "C" ? "APPROVED" : "";

  try {
    const ack = await updatePo({ dominio, numpo: numeroOc, estado: estadoQAD, fecha, desestado });
    const ok = /aceptad/i.test(String(ack || ""));
    return { ok, ack, numeroOc, dominio };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), numeroOc, dominio };
  }
}

/* ======================= LISTADO (OC-centric validando AUTORIZADOR) ======================= */
// ======================= LISTADO (solo lo que le toca al usuario) =======================
router.get("/ordenes", authMiddleware, async (req, res) => {
  const {
    page = 1,
    pageSize = 50,
    sortField = "fechaOC",
    sortOrder = "DESC",
    numeroSolicitud,
    numeroOc,
    compania,
    estado,         // contra cabecera
    fechaInicio,
    fechaFinal,
    proveedor,
    sistema,
    centroCosto,    // contra cabecera
    prioridad,
    nivel,          // se filtra en LIAU
    tipoAutorizador,// se filtra en LIAU
    autorizadores,  // lista de TIAU para LIAU
    verTodo,        // true/1/S → incluye estados finales (por defecto NO)
    personaId: qpPersonaId,
    globalId,
  } = req.query;

  const paging = {
    limit: Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 500),
    offset: Math.max((parseInt(page, 10) || 1) - 1, 0),
  };
  const showAll = String(verTodo ?? "").trim().toLowerCase() === "true"
               || String(verTodo ?? "").trim() === "1"
               || String(verTodo ?? "").trim().toUpperCase() === "S";

  let client;
  try {
    // 1) Filtros de CABECERA (no toco nombres)
    const { whereSQL, params } = buildWhere({
      numeroSolicitud,
      numeroOc,
      compania,
      estado,
      fechaInicio,
      fechaFinal,
      proveedor,
      sistema,
      centroCosto,  // en buildWhere mapeado a cabecera
      prioridad,
      // nivel/tipoAutorizador/autorizadores se usan en subconsulta LIAU
    });

    client = await pool.connect();

    // 2) Resolver persona SÍ o SÍ (nada de admin)
    let personaId = Number.parseInt(String(qpPersonaId ?? ''), 10);
    if (!Number.isFinite(personaId) || personaId <= 0) {
      const resolverUser = { ...(req.user || {}) };
      if (globalId) resolverUser.identificacion = String(globalId).trim();
      personaId = await resolvePersonaId(client, resolverUser);
    }
    if (!personaId) {
      return res.json({ page: 1, pageSize: paging.limit, total: 0, rows: [] });
    }

    // 3) Subcondiciones para LIAU + AUTORIZADOR (vigente)
    const subParams = [];
    const subConds = [
      `a.persona_id_pers = $${params.length + subParams.push(personaId)}`,
      `a.estado_registro = 'A'`,
      `l.estado_registro = 'A'`,
      `(COALESCE(a.temporal,'N') <> 'S'
        OR (a.fecha_inicio_temporal IS NOT NULL AND a.fecha_fin_temporal IS NOT NULL
            AND CURRENT_DATE BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))`,
      ...(showAll ? [] : [`l.estado_oc_id_esta NOT IN (2,3)`]), // por defecto NO finales en LIAU
      ...(nivel ? [`l.nivel_id_nive = $${params.length + subParams.push(parseInt(nivel, 10))}`] : []),
      ...(tipoAutorizador ? [
        `(l.tipo_autorizador_id_tiau = $${params.length + subParams.push(parseInt(tipoAutorizador, 10))}
          OR l.tipo_autorizador_id_tiau IS NULL)`
      ] : []),
      ...(() => {
        const ids = (Array.isArray(autorizadores)
                      ? autorizadores
                      : String(autorizadores ?? '').split(',').filter(Boolean))
                      .map(x => parseInt(x,10)).filter(Number.isFinite);
        return ids.length
          ? [`(l.tipo_autorizador_id_tiau = ANY($${params.length + subParams.push(ids)}::int[])
               OR l.tipo_autorizador_id_tiau IS NULL)`]
          : [];
      })(),
    ];

    // 4) Cabecera: por defecto NO finales (2=APROBADA, 4=CANCELADA)
    let whereSQLFinal = whereSQL;
    if (!showAll) {
      whereSQLFinal += (whereSQLFinal ? " AND " : "WHERE ") + ` c0.estado_oc_id_esta NOT IN (2,4)`;
    }

    // 5) Helper para agregar EXISTS
    const glueExists = (sql, existsClause) => sql ? `${sql} AND ${existsClause}` : `WHERE ${existsClause}`;

    // 6) EXISTS permisos (patrones A y B) — garantiza que SOLO veas lo tuyo
    const existsPermisos = `
      EXISTS (
        SELECT 1
          FROM ${T.LIAU} l
          JOIN doa2.autorizador a
            ON (
                 (
                   -- A) GLOBAL por CC (CC NULL y TIAU igual)
                   l.nivel_id_nive = a.nivel_id_nive
                   AND l.centro_costo_id_ceco IS NULL
                   AND a.centro_costo_id_ceco IS NULL
                   AND l.tipo_autorizador_id_tiau = a.tipo_autorizador_id_tiau
                 )
                 OR
                 (
                   -- B) Dueño CC (CC iguales y TIAU NULL en ambos)
                   l.nivel_id_nive = a.nivel_id_nive
                   AND l.centro_costo_id_ceco = a.centro_costo_id_ceco
                   AND l.tipo_autorizador_id_tiau IS NULL
                   AND a.tipo_autorizador_id_tiau IS NULL
                 )
               )
         WHERE l.cabecera_oc_id_cabe = c0.id_cabe
           AND ${subConds.join(" AND ")}
      )
    `;

    const whereCabMasPerm = glueExists(whereSQLFinal, existsPermisos);

    // 7) COUNT
    const countSQL = `
      SELECT COUNT(*) AS total
        FROM ${T.CABE} c0
      ${whereCabMasPerm}
    `;
    const { rows: rcount } = await client.query(countSQL, [...params, ...subParams]);
    const total = Number.parseInt(rcount[0]?.total || '0', 10);

    // 8) DATA (ids + LATERAL para “mi” LIAU y CC visible)
    const dataSQL = `
      WITH ids AS (
        SELECT c0.id_cabe
          FROM ${T.CABE} c0
        ${whereCabMasPerm}
        ${orderSQL(sortField, sortOrder)}   -- orden sobre columnas de c0
        LIMIT $${params.length + subParams.length + 1}
       OFFSET $${params.length + subParams.length + 2}
      )
      SELECT
        -- IDs esperados por la UI
        c0.id_cabe AS id_cabecera_oc,
        mi.id_liau  AS id_liau,

        -- Cabecera
        c0.id_cabe, c0.categoria_id_cate, c0.estado_oc_id_esta, c0.numero_solicitud,
        c0.numero_orden_compra, c0.fecha_sugerida, c0.fecha_orden_compra, c0.nombre_proveedor,
        c0.contacto_proveedor, c0.direccion_proveedor, c0.telefono_proveedor, c0.ciudad_proveedor,
        c0.departamento_proveedor, c0.pais_proveedor, c0.nit_proveedor, c0.email_proveedor,
        c0.fax_proveedor, c0.nombre_empresa, c0.direccion_empresa, c0.telefono_empresa,
        c0.ciudad_empresa, c0.pais_empresa, c0.nit_empresa, c0.email_empresa, c0.fax_empresa,
        c0.moneda, c0.forma_de_pago, c0.condiciones_de_pago, c0.email_comprador, c0.lugar_entrega,
        c0.observaciones, c0.observacion_compras, c0.usuario_creador, c0.total_bruto,
        c0.descuento_global, c0.sub_total, c0.valor_iva, c0.total_neto, c0.requiere_poliza,
        c0.requiere_contrato, c0.poliza_gestionada, c0.contrato_gestionada, c0.compania,
        c0.sistema, c0.bodega, c0.fecha_creacion, c0.oper_creador, c0.fecha_modificacion,
        c0.oper_modifica, c0.estado_registro, c0.centro_costo_id_ceco, c0.nit_compania,
        c0.solicitante, c0.email_solicitante, c0.prioridad_orden, c0.exitoso_envio_po,
        c0.intento_envio_po, c0.fecha_envio_po, c0.envio_correo, c0."version", c0.id_compania,

        -- Estado del LIAU que te aplica
        mi.id_estado           AS id_estado,
        mi.nombre_estado       AS nombre_estado,

        -- Centro de costo visible
        COALESCE(ccoc.id_ceco, ccl.id_ceco)               AS id_centro_costo,
        COALESCE(ccoc.descripcion, ccl.descripcion)       AS nombre_centro_costo,
        COALESCE(ccoc.codigo, ccl.codigo)                 AS codigo_centro_costo,

        -- 👇 NUEVO: descripción agregada de detalle
        (
          SELECT string_agg(trim(d.descripcion_referencia), ' | ' ORDER BY d.id_deta)
          FROM doa2.detalle_oc d
          WHERE d.cabecera_oc_id_cabe = c0.id_cabe
            AND d.estado_registro = 'A'
        ) AS descripcion_detalle
         
      FROM ids
      JOIN ${T.CABE} c0 ON c0.id_cabe = ids.id_cabe

      LEFT JOIN LATERAL (
        SELECT
          l.id_liau,
          l.estado_oc_id_esta            AS id_estado,
          e.descripcion                  AS nombre_estado,
          l.centro_costo_id_ceco         AS id_centro_costo
        FROM ${T.LIAU} l
        JOIN ${T.ESTA} e
          ON e.id_esta = l.estado_oc_id_esta
        JOIN doa2.autorizador a
          ON (
               (
                 -- A) GLOBAL por CC
                 l.nivel_id_nive = a.nivel_id_nive
                 AND l.centro_costo_id_ceco IS NULL
                 AND a.centro_costo_id_ceco IS NULL
                 AND l.tipo_autorizador_id_tiau = a.tipo_autorizador_id_tiau
               )
               OR
               (
                 -- B) Dueño CC
                 l.nivel_id_nive = a.nivel_id_nive
                 AND l.centro_costo_id_ceco = a.centro_costo_id_ceco
                 AND l.tipo_autorizador_id_tiau IS NULL
                 AND a.tipo_autorizador_id_tiau IS NULL
               )
             )
        WHERE l.cabecera_oc_id_cabe = c0.id_cabe
          AND a.persona_id_pers = $${params.length + 1}  -- mismo índice que en subConds
          AND a.estado_registro = 'A'
          AND l.estado_registro = 'A'
          AND (
                COALESCE(a.temporal,'N') <> 'S'
                OR (a.fecha_inicio_temporal IS NOT NULL AND a.fecha_fin_temporal IS NOT NULL
                    AND CURRENT_DATE BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal)
              )
          ${showAll ? "" : "AND l.estado_oc_id_esta NOT IN (2,3)"}
          ${nivel ? `AND l.nivel_id_nive = $${params.length + (subParams.findIndex(x=>x===parseInt(nivel,10))+1)}` : ""}
          ${
            (() => {
              if (tipoAutorizador) return `AND (l.tipo_autorizador_id_tiau = $${params.length + subParams.length} OR l.tipo_autorizador_id_tiau IS NULL)`;
              return "";
            })()
          }
        ORDER BY
          -- Prioriza Dueño-CC (B) sobre Global (A)
          CASE WHEN l.centro_costo_id_ceco IS NOT NULL AND l.tipo_autorizador_id_tiau IS NULL THEN 0 ELSE 1 END,
          l.nivel_id_nive
        LIMIT 1
      ) mi ON TRUE

      LEFT JOIN ${T.CECO} ccoc ON ccoc.id_ceco = c0.centro_costo_id_ceco
      LEFT JOIN ${T.CECO} ccl  ON ccl.id_ceco  = mi.id_centro_costo

      ${orderSQL(sortField, sortOrder)}
    `;

    const dataParams = [...params, ...subParams, paging.limit, paging.offset * paging.limit];
    const { rows } = await client.query(dataSQL, dataParams);

    res.json({
      page: Number.parseInt(page, 10) || 1,
      pageSize: paging.limit,
      total,
      rows,
    });
  } catch (err) {
    console.error("[GET /ordenes] error:", err);
    res.status(500).json({ error: "No se pudo consultar la bandeja", detalle: err.message });
  } finally {
    client?.release?.();
  }
});


/* ======================= APROBAR ======================= */
router.post("/ordenes/aprobar", authMiddleware, async (req, res) => {
  const { liauIds = [], fromEstadoId, toEstadoId, polizas = [] } = req.body;
  const ids = ints(liauIds);
  const fromId = parseInt(fromEstadoId, 10);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length) return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) {
    return res.status(400).json({ error: "fromEstadoId/toEstadoId inválidos" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    // 1) Snapshot inicial para conocer las OC afectadas
    const { rows: snap } = await client.query(
      `SELECT l.id_liau,
              l.cabecera_oc_id_cabe AS oc_id,
              l.estado_oc_id_esta   AS estado_prev,
              c.estado_oc_id_esta   AS cab_prev,
              c.sistema, c.numero_orden_compra
         FROM ${T.LIAU} l
         JOIN ${T.CABE} c ON c.id_cabe = l.cabecera_oc_id_cabe
        WHERE l.id_liau = ANY($1::int[])`,
      [ids]
    );

    // 2) Reset de cabecera si venía rechazada y hay al menos un LIAU rechazado
    const ocMeta = new Map();
    for (const r of snap) {
      const cur = ocMeta.get(r.oc_id) || {
        sistema: r.sistema,
        numero: r.numero_orden_compra,
        cab_prev: r.cab_prev,
        anyRech: false,
      };
      cur.anyRech = cur.anyRech || Number(r.estado_prev) === ID_RECHAZADO;
      ocMeta.set(r.oc_id, cur);
    }
    for (const [ocId, meta] of ocMeta.entries()) {
      if (Number(meta.cab_prev) === ID_RECHAZADO && meta.anyRech) {
        await client.query(
          `UPDATE ${T.CABE}
              SET estado_oc_id_esta=$2, oper_modifica=$3, fecha_modificacion=NOW()
            WHERE id_cabe=$1`,
          [ocId, ID_INICIADO, oper]
        );
      }
    }

    // 🔥 3) PROPAGACIÓN MULTI-GRUPO (expande liauIds dentro de la misma transacción)
    //    - Mismo aprobador (persona)
    //    - Misma(s) OC(s)
    //    - Mismo estado origen (fromId)
    //    - Coincidencia por reglas de autorizador (GLOBAL CC o Dueño CC)
    const personaId = await resolvePersonaId(client, req.user);
    const ocIdsBase = [...new Set(snap.map(r => r.oc_id))];

    if (personaId && ocIdsBase.length) {
      const { rows: more } = await client.query(
        `
        SELECT l.id_liau
          FROM ${T.LIAU} l
          JOIN doa2.autorizador a
            ON a.persona_id_pers = $1
           AND a.estado_registro = 'A'
           AND l.nivel_id_nive = a.nivel_id_nive
           AND (
                 -- A) GLOBAL por CC (TIAU igual)
                 (l.centro_costo_id_ceco IS NULL AND a.centro_costo_id_ceco IS NULL
                  AND l.tipo_autorizador_id_tiau = a.tipo_autorizador_id_tiau)
                 OR
                 -- B) Dueño CC (TIAU nulo en ambos)
                 (l.centro_costo_id_ceco = a.centro_costo_id_ceco
                  AND l.tipo_autorizador_id_tiau IS NULL
                  AND a.tipo_autorizador_id_tiau IS NULL)
               )
         WHERE l.cabecera_oc_id_cabe = ANY($2::int[])
           AND l.estado_registro = 'A'
           AND l.estado_oc_id_esta = $3
        `,
        [personaId, ocIdsBase, fromId]
      );

      const extraIds = more
        .map(x => x.id_liau)
        .filter(x => !ids.includes(x));
      if (extraIds.length) ids.push(...extraIds);
    }

    // 4) UPDATE principal de LIAU → toId (controlando fromId)
    const upd = await client.query(
      `UPDATE ${T.LIAU} l
          SET estado_oc_id_esta=$2,
              oper_modifica=$3,
              fecha_modificacion=NOW()
        WHERE l.id_liau = ANY($1::int[])
          AND l.estado_oc_id_esta = $4
      RETURNING l.id_liau, l.cabecera_oc_id_cabe AS oc_id, l.observacion`,
      [ids, toId, oper, fromId]
    );

    // 5) Historial
    const estadoDescAprob = await getEstadoDesc(client, toId);
    for (const r of upd.rows) {
      await insertHistorial(client, {
        estado: estadoDescAprob,
        observacion: r.observacion ?? null,
        motivo: null,
        liauId: r.id_liau,
        ocId: r.oc_id,
        oper,
      });
    }

    // 6) Pólizas (si aplica)
    if (Array.isArray(polizas) && polizas.length) {
      const personaIdent = await resolveOperModifica(client, req.user);
      const { rows: pers } = await client.query(
        `SELECT gestion_poliza FROM ${T.PERS} WHERE identificacion=$1 LIMIT 1`,
        [personaIdent]
      );
      if (pers[0]?.gestion_poliza === "S") {
        const ocIds = Array.from(ocMeta.keys());
        for (const ocId of ocIds) {
          let seleccionadas = 0;
          for (const pz of polizas) {
            const idTipoXOc = parseInt(pz.idTipoXOc, 10);
            const idTipo = parseInt(pz.idTipo, 10);
            const porc = Number(pz.porcentaje);
            const activo = pz.seleccionado ? "A" : "I";
            if (pz.seleccionado) seleccionadas++;

            if (Number.isFinite(idTipoXOc)) {
              await client.query(
                `UPDATE ${T.TPOC}
                    SET porcentaje=$2, fecha_modificacion=NOW(), oper_modifica=$3, estado_registro=$4
                  WHERE id_tpoc=$1`,
                [idTipoXOc, porc, oper, activo]
              );
            } else if (Number.isFinite(idTipo)) {
              await client.query(
                `INSERT INTO ${T.TPOC}
                   (porcentaje, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica, estado_registro,
                    tipo_poliza_id_tipo, cabecera_oc_id_cabe, cabecera_oc_pendientes_id_cabe)
                 VALUES ($1, NOW(), $2, NOW(), $2, $3, $4, $5, NULL)`,
                [porc, oper, activo, idTipo, ocId]
              );
            }
          }
          await client.query(
            `UPDATE ${T.CABE}
                SET requiere_poliza = $2, fecha_modificacion=NOW(), oper_modifica=$3
              WHERE id_cabe=$1`,
            [ocId, seleccionadas > 0 ? "S" : "N", oper]
          );
        }
      }
    }

    // 7) Cierre de CABE si todas las LIAU quedaron en toId → QAD "C"
    const ocIds = Array.from(ocMeta.keys());
    if (ocIds.length) {
      const { rows: cierre } = await client.query(
        `SELECT l.cabecera_oc_id_cabe AS oc_id,
                COUNT(*) FILTER (WHERE l.estado_oc_id_esta <> $2)::int AS pendientes_no_aprob
           FROM ${T.LIAU} l
          WHERE l.cabecera_oc_id_cabe = ANY($1::int[])
          GROUP BY l.cabecera_oc_id_cabe`,
        [ocIds, toId]
      );

      for (const row of cierre) {
        if (row.pendientes_no_aprob === 0) {
          const r = await enviarEstadoAQADConBlindaje({ client, ocId: row.oc_id, estadoQAD: "C" });

          let exitosoEnvioPo = "N";
          if (r.skipped) {
            exitosoEnvioPo = "N";
          } else if (r.ok) {
            exitosoEnvioPo = /aceptad/i.test(String(r.ack || "")) ? "S" : "N";
          }

          await client.query(
            `UPDATE ${T.CABE}
                SET estado_oc_id_esta=$2, oper_modifica=$3, fecha_modificacion=NOW(),
                    fecha_envio_po=NOW(), intento_envio_po=1, exitoso_envio_po=$4
              WHERE id_cabe=$1`,
            [row.oc_id, toId, oper, exitosoEnvioPo]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json({
      updated: upd.rowCount,
      requested: ids.length,
      skipped: ids.length - upd.rowCount,
      estadoFinalId: toId,
    });
  } catch (err) {
    await client?.query?.("ROLLBACK");
    console.error("[POST /ordenes/aprobar] error:", err);
    res.status(500).json({ error: "No se pudo aprobar la selección", detalle: err.message });
  } finally {
    client?.release?.();
  }
});


/* ======================= RECHAZAR ======================= */
router.post("/ordenes/rechazar", authMiddleware, async (req, res) => {
  const { liauIds = [], motivoId, observacion = "", fromEstadoId, toEstadoId } = req.body;
  const ids = ints(liauIds);
  const fromId = parseInt(fromEstadoId, 10);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length) return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!Number.isFinite(parseInt(motivoId, 10))) return res.status(400).json({ error: "motivoId inválido" });
  if (!String(observacion).trim()) return res.status(400).json({ error: "observacion es obligatoria" });
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) {
    return res.status(400).json({ error: "fromEstadoId/toEstadoId inválidos" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    // 1) Snapshot inicial (para conocer OC base y registrar historial)
    const { rows: snap } = await client.query(
      `SELECT l.id_liau, l.cabecera_oc_id_cabe AS oc_id
         FROM ${T.LIAU} l
        WHERE l.id_liau = ANY($1::int[])`,
      [ids]
    );

    // 2) 🔥 PROPAGACIÓN MULTI-GRUPO (mismo patrón que aprobar)
    const personaId = await resolvePersonaId(client, req.user);
    const ocIdsBase = [...new Set(snap.map(r => r.oc_id))];

    if (personaId && ocIdsBase.length) {
      const { rows: more } = await client.query(
        `
        SELECT l.id_liau
          FROM ${T.LIAU} l
          JOIN doa2.autorizador a
            ON a.persona_id_pers = $1
           AND a.estado_registro = 'A'
           AND l.nivel_id_nive = a.nivel_id_nive
           AND (
                 -- A) GLOBAL por CC (TIAU igual)
                 (l.centro_costo_id_ceco IS NULL AND a.centro_costo_id_ceco IS NULL
                  AND l.tipo_autorizador_id_tiau = a.tipo_autorizador_id_tiau)
                 OR
                 -- B) Dueño CC (TIAU nulo en ambos)
                 (l.centro_costo_id_ceco = a.centro_costo_id_ceco
                  AND l.tipo_autorizador_id_tiau IS NULL
                  AND a.tipo_autorizador_id_tiau IS NULL)
               )
         WHERE l.cabecera_oc_id_cabe = ANY($2::int[])
           AND l.estado_registro = 'A'
           AND l.estado_oc_id_esta = $3
        `,
        [personaId, ocIdsBase, fromId]
      );

      const extraIds = more.map(x => x.id_liau).filter(x => !ids.includes(x));
      if (extraIds.length) ids.push(...extraIds);
    }

    // 3) UPDATE → RECHAZADO (controlando fromId)
    const upd = await client.query(
      `UPDATE ${T.LIAU} l
          SET estado_oc_id_esta=$2,
              motivo_rechazo_id_more=$3,
              observacion=CASE WHEN COALESCE(l.observacion,'')='' THEN $4 ELSE l.observacion||' | '||$4 END,
              oper_modifica=$5,
              fecha_modificacion=NOW()
        WHERE l.id_liau = ANY($1::int[])
          AND l.estado_oc_id_esta=$6
      RETURNING l.id_liau, l.cabecera_oc_id_cabe AS oc_id`,
      [ids, toId, parseInt(motivoId, 10), norm(observacion), oper, fromId]
    );

    // 4) Historial
    const motivoDesc = await getMotivoDesc(client, motivoId);
    const estadoDesc = await getEstadoDesc(client, toId);
    for (const r of upd.rows) {
      await insertHistorial(client, {
        estado: estadoDesc,
        observacion,
        motivo: motivoDesc,
        liauId: r.id_liau,
        ocId: r.oc_id,
        oper,
      });
    }

    // 5) Actualiza CABECERA + envía a QAD "X"
    const ocIds = Array.from(new Set(upd.rows.map((x) => x.oc_id)));
    for (const ocId of ocIds) {
      const r = await enviarEstadoAQADConBlindaje({ client, ocId, estadoQAD: "X" });

      let exitosoEnvioPo = "N";
      if (r.skipped) {
        exitosoEnvioPo = "N";
      } else if (r.ok) {
        exitosoEnvioPo = /aceptad/i.test(String(r.ack || "")) ? "S" : "N";
      }

      await client.query(
        `UPDATE ${T.CABE}
            SET estado_oc_id_esta=$2,
                oper_modifica=$3,
                fecha_modificacion=NOW(),
                fecha_envio_po=NOW(),
                intento_envio_po=1,
                exitoso_envio_po=$4
          WHERE id_cabe=$1`,
        [ocId, toId, oper, exitosoEnvioPo]
      );
    }

    await client.query("COMMIT");
    res.json({
      updated: upd.rowCount,
      requested: ids.length,
      skipped: ids.length - upd.rowCount,
      estadoFinalId: toId,
    });
  } catch (err) {
    await client?.query?.("ROLLBACK");
    console.error("[POST /ordenes/rechazar] error:", err);
    res.status(500).json({ error: "No se pudo rechazar la selección", detalle: err.message });
  } finally {
    client?.release?.();
  }
});


/* ======================= MÁS DATOS ======================= */
router.post("/ordenes/mas-datos", authMiddleware, async (req, res) => {
  const { liauIds = [], observacion = "", toEstadoId } = req.body;
  const ids = ints(liauIds);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length) return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!String(observacion).trim()) return res.status(400).json({ error: "observacion es obligatoria" });
  if (!Number.isFinite(toId)) return res.status(400).json({ error: "toEstadoId inválido" });

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    // 1) Snapshot inicial para OC base (y fallback de historial)
    const { rows: snap } = await client.query(
      `SELECT l.id_liau, l.cabecera_oc_id_cabe AS oc_id
         FROM ${T.LIAU} l
        WHERE l.id_liau = ANY($1::int[])`,
      [ids]
    );

    // 2) 🔥 PROPAGACIÓN MULTI-GRUPO (sin fromId: barrer vigentes no finales y ≠ toId)
    const personaId = await resolvePersonaId(client, req.user);
    const ocIdsBase = [...new Set(snap.map(r => r.oc_id))];

    if (personaId && ocIdsBase.length) {
      const { rows: more } = await client.query(
        `
        SELECT l.id_liau
          FROM ${T.LIAU} l
          JOIN doa2.autorizador a
            ON a.persona_id_pers = $1
           AND a.estado_registro = 'A'
           AND l.nivel_id_nive = a.nivel_id_nive
           AND (
                 -- A) GLOBAL por CC (TIAU igual)
                 (l.centro_costo_id_ceco IS NULL AND a.centro_costo_id_ceco IS NULL
                  AND l.tipo_autorizador_id_tiau = a.tipo_autorizador_id_tiau)
                 OR
                 -- B) Dueño CC (TIAU nulo en ambos)
                 (l.centro_costo_id_ceco = a.centro_costo_id_ceco
                  AND l.tipo_autorizador_id_tiau IS NULL
                  AND a.tipo_autorizador_id_tiau IS NULL)
               )
         WHERE l.cabecera_oc_id_cabe = ANY($2::int[])
           AND l.estado_registro = 'A'
           AND l.estado_oc_id_esta NOT IN (2,3)   -- evita finales
           AND l.estado_oc_id_esta <> $3          -- evita redundancia con destino
        `,
        [personaId, ocIdsBase, toId]
      );

      const extraIds = more.map(x => x.id_liau).filter(x => !ids.includes(x));
      if (extraIds.length) ids.push(...extraIds);
    }

    // 3) UPDATE → toId (sin filtro fromId para “más datos”)
    const upd = await client.query(
      `UPDATE ${T.LIAU} l
          SET estado_oc_id_esta=$2,
              observacion=CASE WHEN COALESCE(l.observacion,'')='' THEN $3 ELSE l.observacion||' | '||$3 END,
              oper_modifica=$4,
              fecha_modificacion=NOW()
        WHERE l.id_liau = ANY($1::int[])
      RETURNING l.id_liau, l.cabecera_oc_id_cabe AS oc_id`,
      [ids, toId, norm(observacion), oper]
    );

    // 4) Historial (con lo que realmente se tocó)
    const estadoDesc = await getEstadoDesc(client, toId);
    for (const r of upd.rows) {
      await insertHistorial(client, {
        estado: estadoDesc,
        observacion,
        motivo: null,
        liauId: r.id_liau,
        ocId: r.oc_id,
        oper,
      });
    }

    await client.query("COMMIT");
    res.json({
      updated: upd.rowCount,
      requested: ids.length,
      skipped: ids.length - upd.rowCount,
      estadoFinalId: toId,
    });
  } catch (err) {
    await client?.query?.("ROLLBACK");
    console.error("[POST /ordenes/mas-datos] error:", err);
    res.status(500).json({ error: "No se pudo marcar como 'más datos'", detalle: err.message });
  } finally {
    client?.release?.();
  }
});


/* ======================= CATÁLOGOS ======================= */
/* ======================= CATÁLOGOS ======================= */
router.get("/catalogos", authMiddleware, async (_req, res) => {
  let client;
  try {
    client = await pool.connect();

    const qEstados = client.query(
      `SELECT id_esta AS id, descripcion
         FROM ${T.ESTA}
        WHERE estado_registro='A'
        ORDER BY id_esta`
    );

    const qCentros = client.query(
      `SELECT id_ceco AS id, codigo, descripcion
         FROM ${T.CECO}
        ORDER BY descripcion`
    );

    const qMotivos = client.query(
      `SELECT id_more AS id, descripcion
         FROM ${T.MORE}
        WHERE estado_registro='A'
        ORDER BY descripcion`
    );

    const qTipos = client.query(
      `SELECT id_tiau AS id, codigo, descripcion
         FROM ${T.TIAU}
        ORDER BY descripcion`
    );

    const qNiveles = client.query(
      `SELECT id_nive AS id, nivel, descripcion
         FROM ${T.NIVE}
        ORDER BY nivel`
    );

    // 👇 NUEVO: compañías visibles en cabecera_oc + nombre de tabla companias
    const qCompanias = client.query(
      `
      SELECT
        TRIM(c0.compania)                         AS codigo,
        COALESCE(co.nombre_compania, c0.nombre_empresa) AS nombre
      FROM ${T.CABE} c0
      LEFT JOIN doa2.companias co
        ON co.codigo_compania = TRIM(c0.compania)
      WHERE TRIM(COALESCE(c0.compania,'')) <> ''
      GROUP BY TRIM(c0.compania), COALESCE(co.nombre_compania, c0.nombre_empresa)
      ORDER BY COALESCE(co.nombre_compania, c0.nombre_empresa), TRIM(c0.compania)
      `
    );

    const [estados, centros, motivos, tipos, niveles, companias] = await Promise.all([
      qEstados, qCentros, qMotivos, qTipos, qNiveles, qCompanias
    ]);

    res.json({
      estados: estados.rows,
      centrosCosto: centros.rows,
      motivosRechazo: motivos.rows,
      tiposAutorizador: tipos.rows,
      niveles: niveles.rows,
      // 👉 shape consistente para el front
      companias: companias.rows.map(r => ({
        codigo: r.codigo,
        nombre: r.nombre
      })),
    });
  } catch (err) {
    console.error("[GET /catalogos] error:", err);
    res.status(500).json({ error: "No se pudieron obtener catálogos", detalle: err.message });
  } finally {
    client?.release?.();
  }
});

/* ======================= ADJUNTOS DE OC ======================= */

/**
 * Listar adjuntos por OC
 * GET /api/bandeja-autorizacion/archivos/:ocId
 */
router.get("/archivos/:ocId", authMiddleware, async (req, res) => {
  const ocId = parseInt(req.params.ocId, 10);
  if (!Number.isFinite(ocId)) return res.status(400).json({ error: "ocId inválido" });

  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      `SELECT id_arad, nombre_archivo, ubicacion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro,
              cabecera_oc_id_cabe, cabecera_oc_pendientes_id_cabe,
              CASE WHEN archivo IS NULL THEN 'N' ELSE 'S' END AS tiene_blob,
              extension
         FROM ${T.ARAD}
        WHERE cabecera_oc_id_cabe=$1
        ORDER BY fecha_creacion DESC, id_arad DESC`,
      [ocId]
    );

    res.json({
      ocId,
      total: rows.length,
      rows: rows.map(r => ({
        id: r.id_arad,
        nombre: r.nombre_archivo,
        extension: r.extension,
        ubicacion: r.ubicacion,
        tieneBlob: r.tiene_blob === "S",
        creado: r.fecha_creacion,
        estado: r.estado_registro,
        // URL de descarga amigable
        downloadUrl: `/api/bandeja-autorizacion/archivos/${r.id_arad}/download`,
      })),
    });
  } catch (err) {
    console.error("[GET /archivos/:ocId] error:", err);
    res.status(500).json({ error: "No se pudieron listar adjuntos", detalle: err.message });
  } finally {
    client?.release?.();
  }
});

/**
 * Descargar adjunto por ID
 * GET /api/bandeja-autorizacion/archivos/:adjuntoId/download
 */
router.get("/archivos/:adjuntoId/download", authMiddleware, async (req, res) => {
  const adjuntoId = parseInt(req.params.adjuntoId, 10);
  if (!Number.isFinite(adjuntoId)) return res.status(400).json({ error: "adjuntoId inválido" });

  let client;
  try {
    client = await pool.connect();

    // Trae el registro
    const { rows } = await client.query(
      `SELECT id_arad, nombre_archivo, ubicacion, archivo, extension
         FROM ${T.ARAD}
        WHERE id_arad=$1
        LIMIT 1`,
      [adjuntoId]
    );
    if (!rows.length) return res.status(404).json({ error: "Adjunto no existe" });

    // Bases (PATH de parámetros + hints/ENV)
    const basePaths = await getBasePaths(client);

    // Resolver origen y servir
    const desc = await openAdjunto({ row: rows[0], basePaths });

    if (desc.kind === "redirect") {
      return res.redirect(302, desc.url);
    }

    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(desc.filename)}"`);
    res.setHeader("Content-Type", desc.contentType || "application/octet-stream");

    if (desc.kind === "buffer") {
      return res.end(desc.buffer);
    }

    if (desc.kind === "stream") {
      desc.stream.on("error", (e) => {
        console.error("[download stream error]", e);
        if (!res.headersSent) res.status(500).end("Error leyendo el archivo.");
        try { desc.stream.destroy(); } catch {}
      });
      return desc.stream.pipe(res);
    }

    return res.status(500).json({ error: "No se pudo resolver el adjunto" });
  } catch (err) {
    console.error("[GET /archivos/:id/download] error:", err);
    res.status(500).json({ error: "No se pudo descargar el adjunto", detalle: err.message });
  } finally {
    client?.release?.();
  }
});



export default router;
