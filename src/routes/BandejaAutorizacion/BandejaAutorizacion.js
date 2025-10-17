// 💜 Backend — Bandeja del Autorizador (ESM, esquema real)

import express from "express";
import pool from "../../config/db.js";
import authMiddleware from "../../middlewares/auth.middleware.js";
import { updatePo } from "../services/WsActualizacionEstadoQAD.js";

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
};

// IDs “clásicos” de estado_oc según tu carga
const ID_INICIADO = 1;
const ID_APROBADO = 2;
const ID_RECHAZADO = 3;
const ID_MAS_DATOS = 5;

const SORT_MAP = {
  fechaOC: "c0.fecha_orden_compra",
  numeroOc: "c0.numero_orden_compra",
  estado: "e.descripcion",
  empresa: "c0.nombre_empresa",
  centroCosto: "ceco.descripcion",
  prioridad: "c0.prioridad_orden",
  sistema: "c0.sistema",
  id: "liau.id_liau",
  valor: "c0.total_neto",
};

const isSet = (v) =>
  v !== undefined &&
  v !== null &&
  String(v).trim() !== "" &&
  String(v).trim() !== "-1";
const norm = (v) => (v ?? "").toString().trim();
const ints = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(",")) // permite "1,2,3"
    .map((x) => parseInt(x, 10))
    .filter(Number.isFinite);

function orderSQL(sortField, sortOrder) {
  const col = SORT_MAP[sortField] || SORT_MAP.fechaOC;
  const dir =
    String(sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, liau.id_liau DESC`;
}

// Helpers nuevos (arriba, junto a los demás)
const isAdminUser = (u = {}) => {
  const role = String(u.role || "").toUpperCase();
  const roles = (u.roles || []).map((r) => String(r).toUpperCase());
  return role === "ADMIN" || roles.includes("ADMIN");
};

async function resolvePersonaId(client, u = {}) {
  // 1) si viene directo en el token
  const direct = parseInt(u.personaId ?? u.id_persona ?? u.idPersona, 10);
  if (Number.isFinite(direct) && direct > 0) return direct;

  // 2) por identificacion
  if (u.identificacion) {
    const { rows } = await client.query(
      `SELECT id_pers FROM ${T.PERS} WHERE identificacion=$1 LIMIT 1`,
      [String(u.identificacion).trim()]
    );
    if (rows[0]?.id_pers) return parseInt(rows[0].id_pers, 10);
  }

  // 3) por email (si tu auth lo trae)
  if (u.email) {
    const { rows } = await client.query(
      `SELECT id_pers FROM ${T.PERS} WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [String(u.email).trim()]
    );
    if (rows[0]?.id_pers) return parseInt(rows[0].id_pers, 10);
  }

  return null; // no se pudo resolver (mostramos 0 resultados si no es admin)
}

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
  if (isSet(q.compania)) {
    params.push(`%${norm(q.compania)}%`);
    where.push(`(c0.nit_empresa ILIKE $${params.length} OR c0.nombre_empresa  ILIKE $${params.length})`);
  }
  if (isSet(q.sistema)) {
    params.push(norm(q.sistema));
    where.push(`c0.sistema = $${params.length}`);
  }
  if (isSet(q.prioridad)) {
    params.push(norm(q.prioridad));
    where.push(`c0.prioridad_orden = $${params.length}`);
  }

  if (isSet(q.estado)) {
    params.push(parseInt(q.estado, 10));
    where.push(`liau.estado_oc_id_esta = $${params.length}`);
  }
  if (isSet(q.centroCosto)) {
    params.push(parseInt(q.centroCosto, 10));
    where.push(`liau.centro_costo_id_ceco = $${params.length}`);
  }
  if (isSet(q.nivel)) {
    params.push(parseInt(q.nivel, 10));
    where.push(`liau.nivel_id_nive = $${params.length}`);
  }
  if (isSet(q.tipoAutorizador)) {
    params.push(parseInt(q.tipoAutorizador, 10));
    where.push(`liau.tipo_autorizador_id_tiau = $${params.length}`);
  }

  if (isSet(q.fechaInicio) && isSet(q.fechaFinal)) {
    params.push(q.fechaInicio, q.fechaFinal);
    where.push(`c0.fecha_orden_compra BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (isSet(q.fechaInicio) || isSet(q.fechaFinal)) {
    throw new Error("Debes enviar fechaInicio y fechaFinal juntas.");
  }

  const autorizadores = ints(q.autorizadores);
  if (autorizadores.length) {
    params.push(autorizadores);
    where.push(`liau.tipo_autorizador_id_tiau = ANY($${params.length}::int[])`);
  }

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

// Bogota ddMMyy
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

/* ============= Helpers WS QAD + blindaje ============= */

function mapSistemaToDominio(sistema) {
  const s = String(sistema ?? "").trim();
  if (/^\d+$/.test(s)) return s; // ya es "15"/"25"
  if (s.toUpperCase() === "MP") return "15";
  if (s.toUpperCase() === "BM") return "25";
  return "15";
}

function esRechazadoTexto(e = "") {
  const x = String(e || "").toUpperCase();
  return x.startsWith("RECHAZ"); // RECHAZADO / RECHAZADA
}

/**
 * Blindaje:
 * - Si voy a enviar "C" → NO llamar QAD si EXISTE algún RECHAZADO en historial.
 * - Si voy a enviar "X" → llamar 1 vez; si ya hubo RECHAZADO antes, se puede omitir.
 */
async function enviarEstadoAQADConBlindaje({ client, ocId, estadoQAD }) {
  // 1) Datos base
  const { rows: meta } = await client.query(
    `SELECT numero_orden_compra, sistema FROM ${T.CABE} WHERE id_cabe=$1 LIMIT 1`,
    [ocId]
  );
  if (!meta.length) {
    return { ok: false, error: `OC id=${ocId} no existe` };
  }
  const numeroOc = String(meta[0].numero_orden_compra || "").trim();
  const dominio = mapSistemaToDominio(meta[0].sistema);

  // 2) ¿Alguna vez fue rechazada?
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
    console.info(`[QAD SOAP] SKIP UpdatePo(C): OC ${numeroOc} (id:${ocId}) ya tuvo RECHAZO histórico.`);
    return { ok: true, skipped: true, reason: "rechazo_historico", numeroOc, dominio };
  }
  if (estadoQAD === "X" && huboRechazo) {
    console.info(`[QAD SOAP] SKIP UpdatePo(X): OC ${numeroOc} (id:${ocId}) ya estaba RECHAZADA.`);
    return { ok: true, skipped: true, reason: "ya_rechazada", numeroOc, dominio };
  }

  const fecha = ddMMyyBogota(new Date());
  const desestado = estadoQAD === "X" ? "REJECTED" : estadoQAD === "C" ? "APPROVED" : "";

  console.info(`[QAD SOAP] UpdatePo → dominio=${dominio} po=${numeroOc} estado=${estadoQAD} fecha=${fecha} des="${desestado}"`);
  try {
    const ack = await updatePo({
      dominio,
      numpo: numeroOc,
      estado: estadoQAD,
      fecha,
      desestado,
    });
    const ok = /aceptad/i.test(String(ack || ""));
    console.info(`[QAD SOAP] Resultado dominio=${dominio} po=${numeroOc} estado=${estadoQAD} → "${ack}" ${ok ? "✔️ OK" : "⚠️"}`);
    return { ok, ack, numeroOc, dominio };
  } catch (e) {
    console.error(`[QAD SOAP] ERROR UpdatePo dominio=${dominio} po=${numeroOc} estado=${estadoQAD}:`, e?.message || e);
    return { ok: false, error: e?.message || String(e), numeroOc, dominio };
  }
}



// ======================= LISTADO =======================
router.get("/ordenes", authMiddleware, async (req, res) => {
  const {
    page = 1,
    pageSize = 50,
    sortField = "fechaOC",
    sortOrder = "DESC",
    numeroSolicitud,
    numeroOc,
    compania,
    estado,
    fechaInicio,
    fechaFinal,
    proveedor,
    sistema,
    centroCosto,
    prioridad,
    nivel,
    tipoAutorizador,
    autorizadores,
  } = req.query;

  const paging = {
    limit: Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 500),
    offset: Math.max((parseInt(page, 10) || 1) - 1, 0),
  };

  let client;
  try {
    const { whereSQL, params } = buildWhere({
      numeroSolicitud,
      numeroOc,
      compania,
      estado,
      fechaInicio,
      fechaFinal,
      proveedor,
      sistema,
      centroCosto,
      prioridad,
      nivel,
      tipoAutorizador,
      autorizadores,
    });

    client = await pool.connect();

    const admin = isAdminUser(req.user);
    const personaId = admin ? null : await resolvePersonaId(client, req.user);

    let baseFrom = `
      FROM ${T.LIAU} liau
      JOIN ${T.CABE} c0    ON c0.id_cabe = liau.cabecera_oc_id_cabe
      JOIN ${T.ESTA} e     ON e.id_esta  = liau.estado_oc_id_esta
      LEFT JOIN ${T.CECO} ceco ON ceco.id_ceco = liau.centro_costo_id_ceco
      LEFT JOIN ${T.MORE} mr   ON mr.id_more   = liau.motivo_rechazo_id_more
      LEFT JOIN ${T.TIAU} tiau ON tiau.id_tiau = liau.tipo_autorizador_id_tiau
      LEFT JOIN ${T.NIVE} nive ON nive.id_nive = liau.nivel_id_nive
      LEFT JOIN doa2.companias co ON co.codigo_compania = TRIM(c0.compania) -- (+)
    `;

    let whereSQLFinal = whereSQL;
    let paramsFinal = [...params];
    if (!admin) {
      if (!personaId) {
        return res.json({ page: 1, pageSize: paging.limit, total: 0, rows: [] });
      }
      baseFrom += `
        JOIN doa2.lista_autorizaccion_persona lap
          ON lap.id_liau = liau.id_liau
         AND lap.estado_registro = 'A'
      `;
      paramsFinal.push(personaId);
      whereSQLFinal += (whereSQLFinal ? " AND " : "WHERE ") + ` lap.persona_id_pers = $${paramsFinal.length}`;
    }

    const countSQL = `SELECT COUNT(*) AS total ${baseFrom} ${whereSQLFinal}`;
    const { rows: countRows } = await client.query(countSQL, paramsFinal);
    const total = parseInt(countRows[0]?.total || "0", 10);

    const dataSQL = `
      SELECT
        -- Paso
        liau.id_liau,
        liau.observacion AS observacion_paso,         -- (+) conserva observación del paso
        liau.fecha_creacion,
        liau.oper_creador,
        liau.fecha_modificacion,
        liau.oper_modifica,
        liau.estado_registro,

        -- Estado OC
        liau.estado_oc_id_esta      AS id_estado,
        e.descripcion               AS nombre_estado,

        -- Cabecera OC
        liau.cabecera_oc_id_cabe    AS id_cabecera_oc,
        c0.numero_orden_compra,
        c0.numero_solicitud,
        c0.fecha_orden_compra,
        c0.nit_empresa,
        c0.nombre_empresa,

        TRIM(c0.compania) AS compania,               -- (+) código de compañía
        COALESCE(co.nombre_compania, c0.nombre_empresa) AS nombre_compania, -- (+) nombre compañía

        c0.nit_proveedor,
        c0.nombre_proveedor,
        c0.sistema,
        c0.prioridad_orden,
        c0.total_neto,

        c0.observaciones        AS observaciones_oc,       -- (+) observaciones de la OC
        c0.observacion_compras  AS observacion_compras_oc, -- (+) observaciones compras de la OC

        -- Rechazo / Tipo / Nivel / CC
        liau.motivo_rechazo_id_more AS id_motivo_rechazo,
        mr.descripcion              AS motivo_rechazo,

        liau.tipo_autorizador_id_tiau AS id_tipo_autorizador,
        tiau.descripcion              AS tipo_autorizador,

        liau.nivel_id_nive          AS id_nivel,
        nive.descripcion            AS nivel,

        liau.centro_costo_id_ceco   AS id_centro_costo,
        ceco.descripcion            AS nombre_centro_costo,
        ceco.codigo                 AS codigo_centro_costo
      ${baseFrom}
      ${whereSQLFinal}
      ${orderSQL(sortField, sortOrder)}
      LIMIT $${paramsFinal.length + 1} OFFSET $${paramsFinal.length + 2}
    `;

    const dataParams = [...paramsFinal, paging.limit, paging.offset * paging.limit];
    const { rows } = await client.query(dataSQL, dataParams);

    res.json({
      page: parseInt(page, 10) || 1,
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
/**
 * Body:
 * {
 *   liauIds: [..],
 *   fromEstadoId: 1,         // INICIADO
 *   toEstadoId: 2,           // APROBADO
 *   polizas: [               // opcional (si gestion_poliza='S')
 *     { idTipoXOc, idTipo, porcentaje, seleccionado }
 *   ]
 * }
 */
router.post("/ordenes/aprobar", authMiddleware, async (req, res) => {
  const { liauIds = [], fromEstadoId, toEstadoId, polizas = [] } = req.body;
  const ids = ints(liauIds);
  const fromId = parseInt(fromEstadoId, 10);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length)
    return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) {
    return res.status(400).json({ error: "fromEstadoId/toEstadoId inválidos" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    // Snapshot LIAU + cabecera
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

    // Meta por cabecera
    const ocMeta = new Map(); // ocId -> { sistema, numero, cab_prev, anyRech:boolean }
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

    // Reabrir cabecera si estaba RECHAZADA y aprobamos alguno que venía como rechazado
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

    // Aprobar SOLO si siguen en fromId — y traer lo actualizado
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

    // Historial para los efectivamente actualizados
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

    // Si el usuario gestiona pólizas y mandó polizas[], actualiza por cabecera
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

    // Cierre de cabecera si TODAS sus LIAU quedaron en toId → WS QAD "C" (con blindaje)
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
          // Blindaje QAD: no enviar si alguna vez estuvo rechazada
          const r = await enviarEstadoAQADConBlindaje({
            client,
            ocId: row.oc_id,
            estadoQAD: "C",
          });

          let exitosoEnvioPo = "N";
          if (r.skipped) {
            console.info(`[QAD SOAP] Aprobación OC id=${row.oc_id} → envío SKIPPED (${r.reason})`);
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

          // (Opcional) RUP según parámetro APPROVED_DOMAIN_RUP
          try {
            const param = await getParametro(client, "APPROVED_DOMAIN_RUP");
            if (param) {
              const dominios = new Set(
                param.split(";").map((s) => s.trim().toUpperCase()).filter(Boolean)
              );
              const { rows: sisRow } = await client.query(
                `SELECT sistema FROM ${T.CABE} WHERE id_cabe=$1`,
                [row.oc_id]
              );
              const sis = String(sisRow[0]?.sistema || "").trim().toUpperCase();
              if (dominios.has(sis)) {
                // await crearOrdenEnRUP(row.oc_id);
              }
            }
          } catch {
            /* no bloquear */
          }
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
/**
 * Body:
 * {
 *   liauIds:[..],
 *   motivoId: 123,
 *   observacion: "texto",
 *   fromEstadoId: 1,
 *   toEstadoId: 3
 * }
 */
router.post("/ordenes/rechazar", authMiddleware, async (req, res) => {
  const {
    liauIds = [],
    motivoId,
    observacion = "",
    fromEstadoId,
    toEstadoId,
  } = req.body;
  const ids = ints(liauIds);
  const fromId = parseInt(fromEstadoId, 10);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length)
    return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!Number.isFinite(parseInt(motivoId, 10)))
    return res.status(400).json({ error: "motivoId inválido" });
  if (!String(observacion).trim())
    return res.status(400).json({ error: "observacion es obligatoria" });
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) {
    return res.status(400).json({ error: "fromEstadoId/toEstadoId inválidos" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    // Rechazar SOLO si estaban en fromId — y trae lo actualizado
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

    // Historial
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

    // Por cada cabecera afectada → WS QAD "X" (con blindaje: si ya estaba rechazada, no reenvía)
    const ocIds = Array.from(new Set(upd.rows.map((x) => x.oc_id)));
    for (const ocId of ocIds) {
      const r = await enviarEstadoAQADConBlindaje({
        client,
        ocId,
        estadoQAD: "X",
      });

      let exitosoEnvioPo = "N";
      if (r.skipped) {
        console.info(`[QAD SOAP] Rechazo OC id=${ocId} → envío SKIPPED (${r.reason})`);
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
/**
 * Body:
 * {
 *   liauIds:[..],
 *   observacion:"texto",
 *   toEstadoId: 5
 * }
 */
router.post("/ordenes/mas-datos", authMiddleware, async (req, res) => {
  const { liauIds = [], observacion = "", toEstadoId } = req.body;
  const ids = ints(liauIds);
  const toId = parseInt(toEstadoId, 10);

  if (!ids.length)
    return res.status(400).json({ error: "Debes enviar liauIds[]" });
  if (!String(observacion).trim())
    return res.status(400).json({ error: "observacion es obligatoria" });
  if (!Number.isFinite(toId))
    return res.status(400).json({ error: "toEstadoId inválido" });

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const oper = await resolveOperModifica(client, req.user);

    const { rows: snap } = await client.query(
      `SELECT l.id_liau, l.cabecera_oc_id_cabe AS oc_id FROM ${T.LIAU} l WHERE l.id_liau = ANY($1::int[])`,
      [ids]
    );

    const upd = await client.query(
      `UPDATE ${T.LIAU} l
          SET estado_oc_id_esta=$2,
              observacion=CASE WHEN COALESCE(l.observacion,'')='' THEN $3 ELSE l.observacion||' | '||$3 END,
              oper_modifica=$4,
              fecha_modificacion=NOW()
        WHERE l.id_liau = ANY($1::int[])`,
      [ids, toId, norm(observacion), oper]
    );

    const estadoDesc = await getEstadoDesc(client, toId);
    for (const r of snap) {
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
router.get("/catalogos", authMiddleware, async (_req, res) => {
  let client;
  try {
    client = await pool.connect();
    const [estados, centros, motivos, tipos, niveles] = await Promise.all([
      client.query(
        `SELECT id_esta AS id, descripcion FROM ${T.ESTA} WHERE estado_registro='A' ORDER BY id_esta`
      ),
      client.query(
        `SELECT id_ceco AS id, codigo, descripcion FROM ${T.CECO} ORDER BY descripcion`
      ),
      client.query(
        `SELECT id_more AS id, descripcion FROM ${T.MORE} WHERE estado_registro='A' ORDER BY descripcion`
      ),
      client.query(
        `SELECT id_tiau AS id, codigo, descripcion FROM ${T.TIAU} ORDER BY descripcion`
      ),
      client.query(
        `SELECT id_nive AS id, nivel, descripcion FROM ${T.NIVE} ORDER BY nivel`
      ),
    ]);
    res.json({
      estados: estados.rows,
      centrosCosto: centros.rows,
      motivosRechazo: motivos.rows,
      tiposAutorizador: tipos.rows,
      niveles: niveles.rows,
    });
  } catch (err) {
    console.error("[GET /catalogos] error:", err);
    res.status(500).json({ error: "No se pudieron obtener catálogos", detalle: err.message });
  } finally {
    client?.release?.();
  }
});

export default router;
