// src/routes/DOA/PoRouter.js
// Router DOA nueva: bandeja + iniciar + WS

import express from "express";
import pool from "../../config/db.js";
import {
  actualizarOrdenesComprasQAD,
  updatePoStateSOAP,
} from "../services/WsQADBandejanivelCero.js";

const router = express.Router();

/* ========================= Helpers base ========================= */

// Helper: toma el usuario del header (y si no viene, del body, y último fallback "web")
function resolveUsuario(req) {
  const h = req.headers || {};
  // axios manda estos desde el interceptor:
  //  - Authorization: Bearer <token>  (opcional)
  //  - x-global-id: <identificacion>  (preferido)
  //  - x-user-id: <identificacion>    (alias)
  //  - x-persona-id: <id numérico>    (opcional, por si lo quieres usar)
  const gid = String(h["x-global-id"] || h["x-user-id"] || "").trim();
  if (gid) return gid;

  // fallback por compatibilidad (lo que venías enviando en body)
  const bodyUser = (req.body && req.body.usuario) ? String(req.body.usuario).trim() : "";
  if (bodyUser) return bodyUser;

  return "web";
}
const mask = (h = "") => {
  if (!h) return null;
  const [t, k] = String(h).split(" ");
  return k ? `${t} ${k.slice(0, 8)}…${k.slice(-4)}` : h;
};
const isEmpty = (v) => v === undefined || v === null || v === "" || v === "-1";
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const dayRange = (d) => (d && `${d}`.slice(0, 10)) || null;
const asInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const asBool = (v) => String(v).toLowerCase() === "true";

/** Ejecutores */
const run = (clientOrPool, text, params = []) =>
  clientOrPool.query(text, params);
const runOne = async (clientOrPool, text, params = []) =>
  (await clientOrPool.query(text, params)).rows[0];

// 👇 (opcional) si luego quieres usarlo
async function getNivelIdFlex(client, nivelTxt, tipoTxt) {
  let id = await getIdByKey(
    client,
    `SELECT id_nive AS id FROM doa2.nivel WHERE estado_registro='A' AND TRIM(nivel)=TRIM($1)`,
    [String(nivelTxt ?? '').trim()]
  );
  if (id) return id;

  if (tipoTxt) {
    id = await getIdByKey(
      client,
      `SELECT id_nive AS id FROM doa2.nivel WHERE estado_registro='A' AND UPPER(TRIM(nivel))=UPPER(TRIM($1))`,
      [String(tipoTxt ?? '').trim()]
    );
  }
  return id;
}

/** Log */
router.use((req, _res, next) => {
  console.log("[doa/po]", req.method, req.originalUrl, {
    q: req.query,
    body: req.body && Object.keys(req.body).length ? "yes" : "no",
    auth: mask(req.headers.authorization),
  });
  next();
});

/** Map prioridad (texto) */
const PRIORIDAD_STR = `
  CASE UPPER(c0p.prioridad_orden)
    WHEN 'G' THEN 'URGENTE'
    WHEN 'I' THEN 'INVENTARIO'
    WHEN 'N' THEN 'NORMAL'
    WHEN 'P' THEN 'PREVENTIVO'
    WHEN 'U' THEN 'PRIORITARIO'
    ELSE COALESCE(c0p.prioridad_orden,'')
  END
`;

/* ========================= WHERE dinámico (bandeja) ========================= */
function buildWhere(q) {
  const {
    numeroSolicitud,
    numeroOc,
    centroCosto,
    compania,
    solicitante,
    sistema,
    proveedorNit,
    prioridad,
    fechaInicio,
    fechaFin,
    incluirIniciadas,
  } = q;

  const w = [];
  const v = [];
  const ph = (val) => {
    v.push(val);
    return `$${v.length}`;
  };

  // base
  w.push(`(c0p.estado_registro = 'A')`);
  w.push(`COALESCE(c0p.anular,'N') <> 'S'`);
  w.push(`COALESCE(c0p.orden_gestionada,'N') <> 'S'`);
  w.push(`COALESCE(c0p.estado_oc_id_esta,0) NOT IN (2,3,4,5,6)`);

  // Excluir iniciadas (salvo incluirIniciadas=true)
  if (!incluirIniciadas) {
    w.push(`
      NOT EXISTS (
        SELECT 1
          FROM doa2.cabecera_oc co
         WHERE co.estado_registro='A'
           AND co.numero_orden_compra IS NOT NULL
           AND c0p.numero_orden_compra IS NOT NULL
           AND TRIM(co.numero_orden_compra) = TRIM(c0p.numero_orden_compra)
      )`);
  }

  // filtros
  if (!isEmpty(numeroSolicitud))
    w.push(
      `c0p.numero_solicitud ILIKE ${ph("%" + norm(numeroSolicitud) + "%")}`
    );
  if (!isEmpty(numeroOc))
    w.push(`c0p.numero_orden_compra ILIKE ${ph("%" + norm(numeroOc) + "%")}`);
  if (!isEmpty(centroCosto))
    w.push(`TRIM(c0p.centrocosto) = TRIM(${ph(norm(centroCosto))})`);
  if (!isEmpty(compania))
    w.push(`TRIM(c0p.compania)   = TRIM(${ph(norm(compania))})`);
  if (!isEmpty(solicitante))
    w.push(`c0p.solicitante ILIKE ${ph("%" + norm(solicitante) + "%")}`);
  if (!isEmpty(sistema)) w.push(`c0p.sistema = ${ph(sistema)}`);
  if (!isEmpty(proveedorNit))
    w.push(
      `TRIM(c0p.nit_proveedor::text) = TRIM(${ph(String(proveedorNit))}::text)`
    );
  if (!isEmpty(prioridad))
    w.push(`UPPER(c0p.prioridad_orden) = UPPER(${ph(prioridad)})`);

  // rango fechas (fecha_orden_compra)
  const fi = dayRange(fechaInicio);
  const ff = dayRange(fechaFin);
  if (fi) w.push(`c0p.fecha_orden_compra >= ${ph(fi)}::date`);
  if (ff)
    w.push(`c0p.fecha_orden_compra < (${ph(ff)}::date + INTERVAL '1 day')`);

  return { where: w.length ? `WHERE ${w.join(" AND ")}` : "", values: v };
}

/* ========================= Catálogos ========================= */
router.get("/doa/po/catalogos/centros-costo", async (_req, res) => {
  try {
    const { rows } = await run(
      pool,
      `
      SELECT DISTINCT TRIM(c.codigo) AS codigo, COALESCE(TRIM(c.descripcion),'') AS descripcion
      FROM doa2.centro_costo c
      WHERE c.estado_registro = 'A' AND TRIM(c.codigo) <> ''
      ORDER BY 1
    `
    );
    res.json(
      rows.map((r) => ({
        value: r.codigo,
        label: r.descripcion ? `${r.codigo} - ${r.descripcion}` : r.codigo,
      }))
    );
  } catch (e) {
    console.error("centros-costo:", e);
    res.status(500).json({ error: "Error obteniendo centros de costo" });
  }
});
router.get("/doa/po/catalogos/companias", async (_req, res) => {
  try {
    const { rows } = await run(
      pool,
      `
      SELECT DISTINCT TRIM(c0p.compania) AS codigo, COALESCE(co.nombre_compania, c0p.nombre_empresa) AS nombre
      FROM doa2.cabecera_oc_pendientes c0p
      LEFT JOIN doa2.companias co ON co.codigo_compania = TRIM(c0p.compania)
      WHERE TRIM(c0p.compania) <> ''
      ORDER BY 1
    `
    );
    res.json(
      rows.map((x) => ({
        value: x.codigo,
        label: `${x.codigo} - ${x.nombre ?? ""}`.trim(),
      }))
    );
  } catch (e) {
    console.error("companias:", e);
    res.status(500).json({ error: "Error obteniendo compañías" });
  }
});
router.get("/doa/po/catalogos/solicitantes", async (_req, res) => {
  try {
    const { rows } = await run(
      pool,
      `
      SELECT DISTINCT TRIM(solicitante) AS solicitante
      FROM doa2.cabecera_oc_pendientes
      WHERE solicitante IS NOT NULL AND TRIM(solicitante) <> ''
      ORDER BY 1
    `
    );
    res.json(
      rows.map((r) => ({
        value: String(r.solicitante),
        label: String(r.solicitante),
      }))
    );
  } catch (e) {
    console.error("solicitantes:", e);
    res.status(500).json({ error: "Error obteniendo solicitantes" });
  }
});
router.get("/doa/po/catalogos/sistemas", async (_req, res) => {
  try {
    const { rows } = await run(
      pool,
      `
      SELECT DISTINCT TRIM(sistema) AS value, TRIM(sistema) AS label
      FROM doa2.cabecera_oc_pendientes
      WHERE sistema IS NOT NULL AND TRIM(sistema) <> ''
      ORDER BY 1
    `
    );
    res.json(rows);
  } catch (e) {
    console.error("sistemas:", e);
    res.status(500).json({ error: "Error obteniendo sistemas" });
  }
});
router.get("/doa/po/catalogos/proveedores", async (_req, res) => {
  try {
    const { rows } = await run(
      pool,
      `
      SELECT DISTINCT nit_proveedor::text AS nit, COALESCE(nombre_proveedor,'') AS nombre
      FROM doa2.cabecera_oc_pendientes
      WHERE nit_proveedor IS NOT NULL
      ORDER BY 1
    `
    );
    res.json(
      rows.map((x) => ({
        value: x.nit,
        label: `${x.nit} - ${x.nombre}`.trim(),
      }))
    );
  } catch (e) {
    console.error("proveedores:", e);
    res.status(500).json({ error: "Error obteniendo proveedores" });
  }
});

/* ========================= Bandeja (lista paginada) ========================= */
router.get("/doa/po/ordenes", async (req, res) => {
  const {
    numeroSolicitud = "-1",
    numeroOc = "-1",
    centroCosto = "-1",
    compania = "-1",
    solicitante = "-1",
    sistema = "-1",
    proveedorNit = "-1",
    prioridad = "-1",
    fechaInicio,
    fechaFin,
    page = 1,
    pageSize = 20,
    sortField = "reciente",
    sortOrder = "DESC",
    incluirIniciadas = "false",
  } = req.query;

  try {
    const pageNum = asInt(page, 1);
    const sizeNum = asInt(pageSize, 20);
    const offset = (pageNum - 1) * sizeNum;

    const sortable = {
      reciente: "COALESCE(c0p.fecha_orden_compra, c0p.fecha_creacion)",
      "c0p.fecha_orden_compra": "c0p.fecha_orden_compra",
      "c0p.numero_orden_compra": "c0p.numero_orden_compra",
      "c0p.numero_solicitud": "c0p.numero_solicitud",
      "c0p.centrocosto": "c0p.centrocosto",
      "c0p.solicitante": "c0p.solicitante",
      "c0p.compania": "c0p.compania",
      "c0p.sistema": "c0p.sistema",
      "c0p.prioridad_orden": "c0p.prioridad_orden",
      "c0p.nit_proveedor": "c0p.nit_proveedor",
      "c0p.total_neto": "c0p.total_neto",
    };
    const sf = sortable[sortField] || sortable["reciente"];
    const so = String(sortOrder).toUpperCase() === "ASC" ? "ASC" : "DESC";

    const { where, values } = buildWhere({
      numeroSolicitud,
      numeroOc,
      centroCosto,
      compania,
      solicitante,
      sistema,
      proveedorNit,
      prioridad,
      fechaInicio,
      fechaFin,
      incluirIniciadas: asBool(incluirIniciadas),
    });

    const from = `
      FROM doa2.cabecera_oc_pendientes c0p
      LEFT JOIN doa2.companias co ON co.codigo_compania = TRIM(c0p.compania)
      LEFT JOIN doa2.moneda m ON m.codigo = c0p.moneda
    `;

    const sel = `
      SELECT
        c0p.id_cabepen AS "id",
        c0p.numero_solicitud AS "numeroSolicitud",
        c0p.numero_orden_compra AS "numOrden",
        c0p.fecha_orden_compra AS "fechaOrden",
        to_char(c0p.fecha_orden_compra,'YYYY-MM-DD HH24:MI:SS') AS "fechaOrdenString",
        c0p.centrocosto AS "centroCosto",
        TRIM(c0p.compania) AS "compania",
        COALESCE(co.nombre_compania, c0p.nombre_empresa) AS "empresa",
        c0p.sistema AS "sistema",
        c0p.nombre_proveedor AS "descProveedor",
        c0p.nit_proveedor::text AS "nitProveedor",
        c0p.observaciones AS "observaciones",
        c0p.total_neto AS "totalNeto",
        c0p.total_bruto AS "totalBruto",
        c0p.descuento_global AS "dctoGlobal",
        c0p.sub_total AS "subTotal",
        c0p.valor_iva AS "valorIva",
        ${PRIORIDAD_STR} AS "prioridadOrdenStr",
        c0p.prioridad_orden AS "prioridadOrden",
        m.tasa_cambio AS "tasaCambio",
        CASE WHEN m.tasa_cambio IS NOT NULL AND m.tasa_cambio > 0
             THEN ROUND(c0p.sub_total / m.tasa_cambio, 2) ELSE NULL END AS "subtotalEnDolares"
      ${from}
      ${where}
      ORDER BY ${sf} ${so}
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;
    const cnt = `SELECT COUNT(*)::int AS total ${from} ${where}`;

    const [cRes, dRes] = await Promise.all([
      run(pool, cnt, values),
      run(pool, sel, [...values, sizeNum, offset]),
    ]);

    res.json({
      page: pageNum,
      pageSize: sizeNum,
      total: cRes.rows[0]?.total ?? 0,
      data: (dRes.rows || []).map((r) => ({
        ...r,
        valorTotalConIvaDescString: (r.totalNeto ?? 0).toLocaleString("es-CO", {
          minimumFractionDigits: 2,
        }),
      })),
    });
  } catch (e) {
    console.error("GET /doa/po/ordenes:", e);
    res.status(500).json({ error: "Error consultando órdenes" });
  }
});

/* ========================= Detalle ========================= */
router.get("/doa/po/ordenes/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  try {
    // 0) Traer la pendiente para conocer el número de OC
    const p = await runOne(pool, `
      SELECT
        c0p.id_cabepen,
        TRIM(COALESCE(c0p.numero_orden_compra,'')) AS po
      FROM doa2.cabecera_oc_pendientes c0p
      WHERE c0p.id_cabepen = $1::bigint AND c0p.estado_registro='A'
      LIMIT 1
    `, [id]);

    if (!p) return res.status(404).json({ error: "OC pendiente no encontrada" });

    // 1) ¿la tabla cabecera_oc tiene origen_pendiente_id?
    const hasOrigen = await hasColumn("doa2", "cabecera_oc", "origen_pendiente_id", pool);

    // 2) ¿ya está iniciada? (prefiere origen_pendiente_id; si no, por número de OC)
    let co = null;
    if (hasOrigen) {
      const params = [id];
      let clause = `co.origen_pendiente_id = $1::bigint`;
      if (p.po) {
        clause += ` OR (TRIM(COALESCE(co.numero_orden_compra,'')) <> '' AND TRIM(co.numero_orden_compra) = TRIM($2::text))`;
        params.push(p.po);
      }
      co = await runOne(pool, `
        SELECT co.id_cabe
          FROM doa2.cabecera_oc co
         WHERE co.estado_registro='A' AND (${clause})
         LIMIT 1
      `, params);
    } else if (p.po) {
      co = await runOne(pool, `
        SELECT co.id_cabe
          FROM doa2.cabecera_oc co
         WHERE co.estado_registro='A'
           AND TRIM(COALESCE(co.numero_orden_compra,'')) <> ''
           AND TRIM(co.numero_orden_compra) = TRIM($1::text)
         LIMIT 1
      `, [p.po]);
    }

    const iniciada = !!co?.id_cabe;

    if (iniciada) {
      // ======= LECTURA DESDE cabecera_oc + detalle_oc =======
      const head = await runOne(pool, `
        SELECT
          co.id_cabe                         AS "idCabecera",
          co.numero_solicitud                AS "numeroSolicitud",
          co.numero_orden_compra             AS "numeroOrden",
          co.fecha_orden_compra              AS "fechaOrden",
          co.nombre_proveedor                AS "proveedorNombre",
          co.nit_proveedor                   AS "proveedorNit",
          co.email_proveedor                 AS "proveedorEmail",
          co.contacto_proveedor              AS "proveedorContacto",
          co.direccion_proveedor             AS "proveedorDireccion",
          co.telefono_proveedor              AS "proveedorTelefono",
          co.fax_proveedor                   AS "proveedorFax",
          co.ciudad_proveedor                AS "proveedorCiudad",
          co.departamento_proveedor          AS "proveedorDepartamento",
          co.pais_proveedor                  AS "proveedorPais",
          co.nombre_empresa                  AS "empresa",
          co.direccion_empresa               AS "empresaDireccion",
          co.telefono_empresa                AS "empresaTelefono",
          co.ciudad_empresa                  AS "ciudadEmpresa",
          co.pais_empresa                    AS "paisEmpresa",
          co.nit_empresa                     AS "nitEmpresa",
          co.email_empresa                   AS "emailEmpresa",
          co.fax_empresa                     AS "faxEmpresa",
          TRIM(co.compania)                  AS "compania",
          co.nit_compania                    AS "nitCompania",
          co.moneda                          AS "moneda",
          co.forma_de_pago                   AS "formaPago",
          co.condiciones_de_pago             AS "condicionesPago",
          co.email_comprador                 AS "comprador",
          co.lugar_entrega                   AS "lugarEntrega",
          co.solicitante                     AS "solicitanteNombre",
          co.email_solicitante               AS "solicitanteEmail",
          cc.codigo                          AS "centroCostoStr",
          co.prioridad_orden                 AS "prioridad",
          co.observaciones                   AS "observaciones",
          co.observacion_compras             AS "observacionCompras",
          co.total_bruto                     AS "totalBrutoCab",
          co.sub_total                       AS "subTotalCab",
          co.valor_iva                       AS "valorIvaCab",
          co.total_neto                      AS "totalNetoCab",
          co.estado_registro                 AS "estadoRegistro"
        FROM doa2.cabecera_oc co
        LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = co.centro_costo_id_ceco
        WHERE co.id_cabe = $1
        LIMIT 1
      `, [co.id_cabe]);

      const detRes = await run(pool, `
        SELECT
          d.id_deta            AS "idDetalle",
          d.cabecera_oc_id_cabe AS "idCabecera",
          d.referencia         AS "referencia",
          d.descripcion_referencia AS "descripcion",
          d.unidad_medida      AS "unidadMedida",
          d.fecha_entrega      AS "fechaEntrega",
          d.cantidad::numeric  AS "cantidad",
          d.valor_unidad::numeric AS "valorUnitario",
          d.descuento::numeric AS "descuentoRef",
          d.iva::numeric       AS "ivaRef",
          d.valor_descuento::numeric     AS "valorDescuento",
          d.valor_iva::numeric           AS "valorIva",
          d.valor_sin_iva_descuento::numeric AS "valorSinIvaDesc",
          d.valor_total::numeric         AS "valorTotal",
          d.estado_registro              AS "estadoRegistro"
        FROM doa2.detalle_oc d
        WHERE d.cabecera_oc_id_cabe = $1
          AND d.estado_registro = 'A'
        ORDER BY d.id_deta
      `, [co.id_cabe]);

      const totRow = await runOne(pool, `
        SELECT
          SUM(d.cantidad * d.valor_unidad)::numeric   AS "totalBruto",
          SUM(d.valor_descuento)::numeric             AS "dctoGlobal",
          SUM(d.valor_sin_iva_descuento)::numeric     AS "subTotal",
          SUM(d.valor_iva)::numeric                   AS "valorIva",
          SUM(d.valor_total)::numeric                 AS "totalNeto",
          m.tasa_cambio::numeric                      AS "tasaCambio"
        FROM doa2.detalle_oc d
        JOIN doa2.cabecera_oc co ON co.id_cabe = d.cabecera_oc_id_cabe
        LEFT JOIN doa2.moneda m  ON m.codigo = co.moneda
       WHERE d.cabecera_oc_id_cabe = $1
         AND d.estado_registro = 'A'
       GROUP BY m.tasa_cambio
      `, [co.id_cabe]);

      const tc = Number(totRow?.tasaCambio || 0);
      const subTotal = Number(totRow?.subTotal || 0);
      const totales = {
        totalBruto: Number(totRow?.totalBruto || 0),
        dctoGlobal: Number(totRow?.dctoGlobal || 0),
        subTotal,
        valorIva: Number(totRow?.valorIva || 0),
        totalNeto: Number(totRow?.totalNeto || 0),
        subtotalUSD: tc > 0 ? subTotal / tc : null,
      };

      return res.json({
        fuente: "iniciada",
        idCabecera: co.id_cabe,
        cabecera: head,
        detalle: detRes.rows,
        totales,
      });
    }

    // ======= LECTURA DESDE PENDIENTE =======
    const head = await runOne(pool, `
      SELECT
        c.id_cabepen AS "id",
        c.numero_solicitud AS "numeroSolicitud",
        c.numero_orden_compra AS "numeroOrden",
        c.fecha_orden_compra AS "fechaOrden",
        c.nombre_proveedor AS "proveedorNombre",
        c.nit_proveedor AS "proveedorNit",
        c.email_proveedor AS "proveedorEmail",
        c.contacto_proveedor AS "proveedorContacto",
        c.direccion_proveedor AS "proveedorDireccion",
        c.telefono_proveedor AS "proveedorTelefono",
        c.fax_proveedor AS "proveedorFax",
        c.ciudad_proveedor AS "proveedorCiudad",
        c.departamento_proveedor AS "proveedorDepartamento",
        c.pais_proveedor AS "proveedorPais",
        c.nombre_empresa AS "empresa",
        c.direccion_empresa AS "empresaDireccion",
        c.telefono_empresa AS "empresaTelefono",
        c.ciudad_empresa AS "ciudadEmpresa",
        c.pais_empresa AS "paisEmpresa",
        c.nit_empresa AS "nitEmpresa",
        c.email_empresa AS "emailEmpresa",
        c.fax_empresa AS "faxEmpresa",
        c.compania AS "compania",
        c.nit_compania AS "nitCompania",
        c.moneda AS "moneda",
        c.forma_de_pago AS "formaPago",
        c.condiciones_de_pago AS "condicionesPago",
        c.email_comprador AS "comprador",
        c.lugar_entrega AS "lugarEntrega",
        c.solicitante AS "solicitanteNombre",
        c.correo_solicitante AS "solicitanteEmail",
        c.centrocosto AS "centroCostoStr",
        c.prioridad_orden AS "prioridad",
        c.observaciones AS "observaciones",
        c.observacion_compras AS "observacionCompras",
        c.total_bruto AS "totalBruto",
        c.descuento_global AS "descuentoGlobal",
        c.sub_total AS "subTotal",
        c.valor_iva AS "valorIva",
        c.total_neto AS "totalNeto",
        c.requiere_poliza AS "requierePoliza",
        c.requiere_contrato AS "requiereContrato",
        c.estado_registro AS "estadoRegistro",
        c.inicio_masivo AS "inicioMasivo",
        c.orden_gestionada AS "ordenGestionada",
        c.envio_correo AS "envioCorreo"
      FROM doa2.cabecera_oc_pendientes c
      WHERE c.id_cabepen = $1::bigint
      LIMIT 1
    `, [id]);

    const detRes = await run(pool, `
      SELECT
        d.id_deta_pendiente AS "idDetalle",
        d.id_cabepen AS "idCabecera",
        d.referencia AS "referencia",
        d.descripcion_referencia AS "descripcion",
        d.unidad_medida AS "unidadMedida",
        d.fecha_entrega AS "fechaEntrega",
        d.cantidad::numeric AS "cantidad",
        d.valor_unidad::numeric AS "valorUnitario",
        d.descuento::numeric AS "descuentoRef",
        d.iva::numeric AS "ivaRef",
        d.valor_descuento::numeric AS "valorDescuento",
        d.valor_iva::numeric AS "valorIva",
        d.valor_sin_iva_descuento::numeric AS "valorSinIvaDesc",
        d.valor_total::numeric AS "valorTotal",
        d.estado_registro AS "estadoRegistro"
      FROM doa2.detalle_oc_pendiente d
      WHERE d.id_cabepen = $1::bigint
        AND d.estado_registro = 'A'
      ORDER BY d.id_deta_pendiente
    `, [id]);

    const totRow = await runOne(pool, `
      SELECT
        SUM(d.cantidad * d.valor_unidad)::numeric           AS "totalBruto",
        SUM(d.valor_descuento)::numeric                     AS "dctoGlobal",
        SUM(d.valor_sin_iva_descuento)::numeric             AS "subTotal",
        SUM(d.valor_iva)::numeric                           AS "valorIva",
        SUM(d.valor_total)::numeric                         AS "totalNeto",
        m.tasa_cambio::numeric                              AS "tasaCambio"
      FROM doa2.detalle_oc_pendiente d
      JOIN doa2.cabecera_oc_pendientes c ON c.id_cabepen = d.id_cabepen
      LEFT JOIN doa2.moneda m ON m.codigo = c.moneda
      WHERE d.id_cabepen = $1::bigint
        AND d.estado_registro = 'A'
      GROUP BY m.tasa_cambio
    `, [id]);

    const tc = Number(totRow?.tasaCambio || 0);
    const subTotal = Number(totRow?.subTotal || 0);
    const totales = {
      totalBruto: Number(totRow?.totalBruto || 0),
      dctoGlobal: Number(totRow?.dctoGlobal || 0),
      subTotal,
      valorIva: Number(totRow?.valorIva || 0),
      totalNeto: Number(totRow?.totalNeto || 0),
      subtotalUSD: tc > 0 ? subTotal / tc : null,
    };

    res.json({ fuente: "pendiente", cabecera: head, detalle: detRes.rows, totales });
  } catch (e) {
    console.error("GET /doa/po/ordenes/:id:", e);
    res.status(500).json({ error: "Error consultando la OC" });
  }
});



/* ========================= Introspección ========================= */
async function hasTable(schema, table, client = pool) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`,
    [schema, table]
  );
  return rows.length > 0;
}
async function hasColumn(schema, table, column, client = pool) {
  const { rows } = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 AND column_name=$3
      LIMIT 1`,
    [schema, table, column]
  );
  return rows.length > 0;
}

/* ========================= Reglas/Evaluación helpers ========================= */
const S2 = (v) => String(v ?? "").trim();
const U2 = (v) => S2(v).toUpperCase();
const NOW_ISO2 = () => new Date().toISOString();

async function existsCentro2(codigo, client = pool) {
  await client.query(
    `SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`
  );
  const { rows } = await client.query(
    `SELECT 1 FROM doa2.centro_costo
      WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1)) LIMIT 1`,
    [codigo]
  );
  return rows.length > 0;
}
async function existsCategoria2(nombre, client = pool) {
  await client.query(
    `SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`
  );
  const { rows } = await client.query(
    `SELECT 1 FROM doa2.categoria
      WHERE estado_registro='A'
        AND (UPPER(TRIM(categoria))=UPPER(TRIM($1)) OR UPPER(TRIM(descripcion))=UPPER(TRIM($1)))
      LIMIT 1`,
    [nombre]
  );
  return rows.length > 0;
}
async function loadRulesParam2(client = pool) {
  await client.query(
    `SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`
  );
  const { rows } = await client.query(
    `SELECT valor FROM doa2.parametros WHERE parametro='REGLAS_OC' AND estado_registro='A' LIMIT 1`
  );
  if (!rows.length) return { version: 1, updatedAt: NOW_ISO2(), reglas: [] };
  try {
    const data = JSON.parse(rows[0].valor || "{}");
    data.reglas = Array.isArray(data.reglas) ? data.reglas : [];
    return data;
  } catch {
    return { version: 1, updatedAt: NOW_ISO2(), reglas: [] };
  }
}
function computeMinBounds2(reglas) {
  const byKey = new Map();
  for (const r of reglas) {
    // 👇 sin compañía
    const key = `${U2(r.centroCosto)}|${U2(r.reglaNegocio || "INDIRECT")}|${U2(
      r.categoria || ""
    )}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const minMap = new Map();
  for (const arr of byKey.values()) {
    const allHaveMin = arr.every((x) => typeof x.minExp === "number");
    if (allHaveMin) {
      for (const r of arr) minMap.set(r.id, Number(r.minExp || 0));
      continue;
    }
    arr.sort((a, b) => Number(a.montoMax || 0) - Number(b.montoMax || 0));
    arr.forEach((r, i) => {
      const min = i === 0 ? 0 : Number(arr[i - 1].montoMax || 0) + 1;
      minMap.set(r.id, min);
    });
  }
  return minMap;
}

function kStepEval(a) {
  return `${U2(a.tipo)}|${S2(a.nivel)}`;
}
function pasosSinDuplicar2(arr) {
  const seen = new Set();
  const out = [];
  for (const a of arr || []) {
    const k = kStepEval(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ tipo: U2(a.tipo), nivel: S2(a.nivel) });
  }
  return out;
}
function parseNivelNum2(n) {
  const s = S2(n);
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
}

/* ======= Categoría en cabecera (por ítems homologados) ======= */
function inferReglaNegocio(nombreCategoria = "") {
  const c = U2(nombreCategoria);
  if (/^INTERCOMPANY/.test(c)) return "INTERCOMPANY";
  if (/^(DIRECTO|PLOMO|DIRECTOPACIFICO)/.test(c)) return "DIRECT";
  return "INDIRECT";
}

async function getCabeceraConCategoria(idCabecera, client = pool) {
  const { rows } = await client.query(
    `
WITH cat_cab AS (
  SELECT co.categoria_id_cate
  FROM doa2.cabecera_oc co
  WHERE co.id_cabe=$1
),
cat_det AS (
  SELECT ic.categoria_id_cate
  FROM doa2.detalle_oc d
  JOIN doa2.item_x_categoria ic ON ic.id_itca = d.item_x_categoria_id_itca AND ic.estado_registro='A'
  JOIN doa2.categoria cat2      ON cat2.id_cate = ic.categoria_id_cate
  WHERE d.cabecera_oc_id_cabe=$1
  GROUP BY ic.categoria_id_cate
  ORDER BY MIN(
    CASE
      WHEN UPPER(TRIM(cat2.categoria)) LIKE 'INTERCOMPANY%' THEN 1
      WHEN UPPER(TRIM(cat2.categoria)) IN ('DIRECTO','PLOMO','DIRECTOPACIFICO') THEN 2
      ELSE 3
    END
  )
  LIMIT 1
)
SELECT
  co.id_cabe,
  UPPER(TRIM(cc.codigo))       AS centrocosto,
  TRIM(co.compania)            AS compania,
  co.total_neto,
  co.numero_orden_compra,
  COALESCE((SELECT categoria_id_cate FROM cat_cab),
           (SELECT categoria_id_cate FROM cat_det))       AS categoria_id_cate,
  UPPER(TRIM(cat.categoria))   AS categoria_nombre
FROM doa2.cabecera_oc co
LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = co.centro_costo_id_ceco
LEFT JOIN doa2.categoria   cat ON cat.id_cate = COALESCE(
                                   (SELECT categoria_id_cate FROM cat_cab),
                                   (SELECT categoria_id_cate FROM cat_det)
                                 )
WHERE co.id_cabe = $1
LIMIT 1
  `,
    [idCabecera]
  );
  return rows[0] || null;
}

async function findAutorizadoresBatch2(steps, centroCodigo, client = pool) {
  if (!steps?.length) return new Map();

  // 1) Resolver id_nive para cada paso una vez
  const pairs = []; // { key: 'TIPO|NIVEL', idNivel, nivelTxt }
  const seenIds = new Set();
  for (const s of steps) {
    const nivelTxt = String(s.nivel || '').trim();
    if (!nivelTxt) continue;
    const idNivel = await getNivelId(client, nivelTxt).catch(() => null);
    if (!idNivel) continue;
    pairs.push({ key: `${String(s.tipo||'').trim().toUpperCase()}|${nivelTxt}`, idNivel, nivelTxt });
    seenIds.add(idNivel);
  }
  if (!pairs.length) return new Map();

  // 2) Resolver id del centro (por código)
  let idCentro = null;
  if (centroCodigo) {
    const r = await client.query(
      `SELECT id_ceco AS id
         FROM doa2.centro_costo
        WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1))
        LIMIT 1`,
      [centroCodigo]
    );
    idCentro = r.rows[0]?.id ?? null;
  }

  // 3) Traer personas por nivel_id_nive (y centro si aplica)
  const idNiveles = [...seenIds];
  const params = [idNiveles];
  let where = `
    a.estado_registro='A'
    AND a.nivel_id_nive = ANY($1)
    AND (a.temporal IS NULL OR a.temporal <> 'S'
         OR (now() BETWEEN COALESCE(a.fecha_inicio_temporal, now()) AND COALESCE(a.fecha_fin_temporal, now())))
  `;
  if (idCentro) {
    where += ` AND (a.centro_costo_id_ceco = $${params.push(idCentro)} OR a.centro_costo_id_ceco IS NULL)`;
  }

  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT a.nivel_id_nive AS id_nivel,
            p.id_pers, p.identificacion, p.nombre, p.email,
            CASE WHEN a.centro_costo_id_ceco IS NULL THEN 1 ELSE 0 END AS prioridad
       FROM doa2.autorizador a
       JOIN doa2.persona p ON p.id_pers=a.persona_id_pers AND p.estado_registro='A'
      WHERE ${where}
      ORDER BY id_nivel, prioridad ASC, p.nombre`,
    params
  );

  // 4) Agrupar por id de nivel
  const byNivelId = new Map();
  for (const r of rows) {
    let arr = byNivelId.get(r.id_nivel);
    if (!arr) byNivelId.set(r.id_nivel, (arr = []));
    if (!arr.some(x => x.id === String(r.id_pers))) {
      arr.push({
        id: String(r.id_pers),
        globalId: r.identificacion,
        nombre: r.nombre,
        email: r.email,
      });
    }
  }

  // 5) Volcar al mapa esperado (clave = TIPO|NIVEL)
  const out = new Map();
  for (const { key, idNivel } of pairs) {
    out.set(key, byNivelId.get(idNivel) || []);
  }
  return out;
}

async function evaluarReglasParaCabecera(idCabecera, client = pool) {
  const cab = await getCabeceraConCategoria(idCabecera, client);
  if (!cab) return { ok: false, reason: "cabecera no encontrada" };

  const centroCosto  = U2(cab.centrocosto || "");
  const compania     = S2(cab.compania || "");
  const monto        = Number(cab.total_neto || 0);
  const categoria    = U2(cab.categoria_nombre || "");
  const reglaNegocio = inferReglaNegocio(cab.categoria_nombre || "");

  if (!centroCosto) return { ok: false, reason: "sin centro de costo" };
  if (!categoria)   return { ok: false, reason: "sin categoría homologada" };

  const [okCentro, okCategoriaBD] = await Promise.all([
    existsCentro2(centroCosto, client),
    existsCategoria2(categoria, client),
  ]);
  if (!okCentro)      return { ok: false, reason: `centro inexistente: ${centroCosto}` };
  if (!okCategoriaBD) return { ok: false, reason: `categoría inexistente: ${categoria}` };

  const data = await loadRulesParam2(client);
  const reglas = (data.reglas || [])
    .map((r) => ({
      id: S2(r.id),
      reglaNegocio: U2(r.reglaNegocio || "INDIRECT"),
      centroCosto: U2(r.centroCosto),
      categoria: U2(r.categoria || ""),
      minExp: typeof r.minExp === "number" ? Number(r.minExp) : undefined,
      montoMax: Number(r.montoMax || 0),
      aprobadores: Array.isArray(r.aprobadores)
        ? r.aprobadores.map((a) => ({ tipo: U2(a.tipo), nivel: S2(a.nivel) }))
        : [],
      vigente: r.vigente !== false,
      updatedAt: r.updatedAt || NOW_ISO2(),
    }))
    .filter((r) =>
      r.vigente &&
      r.reglaNegocio === reglaNegocio &&
      r.centroCosto   === centroCosto &&
      r.categoria     === categoria
    );

  if (!reglas.length) return { ok: false, reason: "no hay reglas para centro/categoría/regla" };

  const minMap = computeMinBounds2(reglas);
  const dentro = (r) => {
    const min = typeof r.minExp === "number" ? r.minExp : minMap.get(r.id) ?? 0;
    return min <= monto && monto <= Number(r.montoMax || 0);
  };
  const candidatas = reglas.filter(dentro);
  if (!candidatas.length) return { ok: false, reason: "monto fuera de rango" };
  const elegida = candidatas.sort(
    (a, b) =>
      a.montoMax - b.montoMax ||
      (minMap.get(a.id) ?? 0) - (minMap.get(b.id) ?? 0)
  )[0];

  const pasos = pasosSinDuplicar2(elegida.aprobadores).sort((a, b) => {
    const na = parseNivelNum2(a.nivel),
      nb = parseNivelNum2(b.nivel);
    if (na !== nb) return na - nb;
    return S2(a.nivel).localeCompare(S2(b.nivel));
  });

  const personasMap = await findAutorizadoresBatch2(pasos, centroCosto, client);
  const aprobadores = pasos.map((step) => ({
    tipo: U2(step.tipo),
    nivel: S2(step.nivel),
    centroCosto,
    personas: personasMap.get(kStepEval(step)) || [],
  }));

  return {
    ok: true,
    regla: {
      id: elegida.id,
      reglaNegocio: elegida.reglaNegocio,
      centroCosto,
      compania,
      categoria,
      rango: {
        min:
          typeof elegida.minExp === "number"
            ? elegida.minExp
            : minMap.get(elegida.id) ?? 0,
        max: elegida.montoMax,
      },
    },
    aprobadores,
  };
}

/* ======= Persistencia de flujo ======= */
/** NOTA: Ya NO se usa lista_autorizaccion_persona. Solo crea pasos en lista_autorizaccion. */
async function getIdByKey(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0]?.id ?? null;
}
async function getTipoId(client, tipoCodigo) {
  return getIdByKey(
    client,
    `SELECT id_tiau AS id FROM doa2.tipo_autorizador WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1))`,
    [tipoCodigo]
  );
}
async function getNivelId(client, nivelTxt) {
  return getIdByKey(
    client,
    `SELECT id_nive AS id FROM doa2.nivel WHERE estado_registro='A' AND TRIM(nivel)=TRIM($1)`,
    [nivelTxt]
  );
}
async function getCentroId(client, centroCodigo) {
  return getIdByKey(
    client,
    `SELECT id_ceco AS id FROM doa2.centro_costo WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1))`,
    [centroCodigo]
  );
}

async function persistirFlujoAutorizacion({ client, idCabecera, centroCosto, aprobadores, usuario }) {
  const hasLista     = await hasTable('doa2','lista_autorizaccion', client);
  if (!hasLista) return { pasos: [], personas: [], note:'tabla lista_autorizaccion no existe' };

  const hasColEstadoPasoLA = await hasColumn('doa2','lista_autorizaccion','estado_paso', client);
  const hasColOrdenLA      = await hasColumn('doa2','lista_autorizaccion','orden', client);
  const hasColEstadoOC_LA  = await hasColumn('doa2','lista_autorizaccion','estado_oc_id_esta', client);

  // IDs base
  const idCentro = await getCentroId(client, centroCosto).catch(()=>null);

  const outPasos = [];
  const outPers  = []; // solo informativo (no se persiste)

  let ordenCalc = 0;

  /* =========================
   *  Paso 0: DUENO CC SIEMPRE
   * ========================= */
  try {
    const NIVEL_ID_DUENO =
      (await getIdByKey(
        client,
        `SELECT id_nive AS id
           FROM doa2.nivel
          WHERE estado_registro='A'
            AND UPPER(TRANSLATE(TRIM(nivel),'ÑÁÉÍÓÚÜ','NAEIOUSU')) IN ('DUENO CC','DUENO  CC','DUENOCC','DUENO DE CC','DUENO CENTRO','DUEÑO CC')
          LIMIT 1`,
        []
      )) ?? 11;

    // Traemos posibles personas (solo para respuesta/log; no se guardan en ninguna tabla)
    const params = [NIVEL_ID_DUENO];
    let centroWhere = '';
    if (idCentro) {
      centroWhere = ` AND (a.centro_costo_id_ceco = $${params.push(idCentro)} OR a.centro_costo_id_ceco IS NULL)`;
    } else {
      centroWhere = ` AND a.centro_costo_id_ceco IS NULL`;
    }

    await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
    const { rows: dueRows } = await client.query(
      `
      SELECT p.id_pers, p.nombre, p.email,
             CASE WHEN a.centro_costo_id_ceco IS NULL THEN 1 ELSE 0 END AS prioridad
        FROM doa2.autorizador a
        JOIN doa2.persona p ON p.id_pers=a.persona_id_pers AND p.estado_registro='A'
       WHERE a.estado_registro='A'
         AND a.nivel_id_nive = $1
         ${centroWhere}
         AND (a.temporal IS NULL OR a.temporal <> 'S'
              OR (now() BETWEEN COALESCE(a.fecha_inicio_temporal, now()) AND COALESCE(a.fecha_fin_temporal, now())))
       ORDER BY prioridad ASC, p.nombre
      `,
      params
    );

    // Insert del paso (tipo NULL para DUEÑO CC)
    const cols = ['cabecera_oc_id_cabe','nivel_id_nive','estado_registro','fecha_creacion','oper_creador'];
    const vals = ['$1','$2',`'A'`,'NOW()','$3'];
    const args = [idCabecera, NIVEL_ID_DUENO, usuario];

    if (idCentro) { cols.push('centro_costo_id_ceco'); vals.push('$'+(args.push(idCentro))); }
    if (hasColOrdenLA)      { cols.push('orden');             vals.push('$'+(args.push(++ordenCalc))); }
    if (hasColEstadoPasoLA) { cols.push('estado_paso');       vals.push(`'P'`); }
    if (hasColEstadoOC_LA)  { cols.push('estado_oc_id_esta'); vals.push('1'); }

    cols.push('tipo_autorizador_id_tiau'); vals.push('NULL');

    const insPaso = await client.query(
      `INSERT INTO doa2.lista_autorizaccion (${cols.join(',')})
       VALUES (${vals.join(',')})
       RETURNING id_liau`,
      args
    );
    const idLista = insPaso.rows[0]?.id_liau;
    outPasos.push({ idLista, etapa: 'DUENO_CC', nivelId: NIVEL_ID_DUENO });

    // guardamos personas solo en la respuesta (no persiste en ninguna tabla)
    for (const r of dueRows) {
      outPers.push({ idLista, idPersona: String(r.id_pers), nombre: r.nombre, email: r.email });
    }
  } catch (e) {
    outPasos.push({ warn: 'DUEÑO CC: error insertando', error: String(e?.message || e) });
  }

  /* ==================================
   *  Resto de pasos (desde las REGLAS)
   * ================================== */
  for (const step of (aprobadores || [])) {
    const idNivel = await getNivelId(client, step.nivel).catch(() => null);
    const idTipo  = await getTipoId(client, step.tipo).catch(() => null);

    if (!idNivel) {
      outPasos.push({ warn: 'No se resolvió id de nivel', step });
      continue;
    }

    const cols = ['cabecera_oc_id_cabe'];
    const vals = ['$1'];
    const args = [idCabecera];
    const addParam = (v) => '$' + (args.push(v));

    cols.push('tipo_autorizador_id_tiau'); vals.push(idTipo ? addParam(idTipo) : 'NULL');
    cols.push('nivel_id_nive');            vals.push(addParam(idNivel));

    if (idCentro) { cols.push('centro_costo_id_ceco'); vals.push(addParam(idCentro)); }
    if (hasColOrdenLA)      { cols.push('orden');             vals.push(addParam(++ordenCalc)); }
    if (hasColEstadoPasoLA) { cols.push('estado_paso');       vals.push(`'P'`); }
    if (hasColEstadoOC_LA)  { cols.push('estado_oc_id_esta'); vals.push('1'); }

    cols.push('estado_registro'); vals.push(`'A'`);
    cols.push('fecha_creacion');  vals.push('NOW()');
    cols.push('oper_creador');    vals.push(addParam(usuario));

    const insPaso = await client.query(
      `INSERT INTO doa2.lista_autorizaccion (${cols.join(',')})
       VALUES (${vals.join(',')})
       RETURNING id_liau`,
      args
    );

    const idLista = insPaso.rows[0]?.id_liau;
    outPasos.push({ idLista, tipo: step.tipo, nivel: step.nivel });

    // personas: solo informativo
    if (Array.isArray(step.personas) && step.personas.length) {
      for (const per of step.personas) {
        outPers.push({ idLista, idPersona: per.id, nombre: per.nombre, email: per.email });
      }
    }
  }

  return { pasos: outPasos, personas: outPers };
}

/* ========================= Iniciar ========================= */
router.post("/doa/po/iniciar", async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite)
    : [];
  const usuario = resolveUsuario(req);
  const validar = req.body?.validar !== false; // default: true
  const persist = req.body?.persist !== false; // default: true
  const forzar  = req.body?.forzar === true;   // default: false

  if (!ids.length) return res.status(400).json({ error: "Sin IDs" });

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const hasOrigen = await hasColumn("doa2", "cabecera_oc", "origen_pendiente_id", client);

    // ===== Pre-validación de homologación (estricta) =====
    const faltantesRefs = new Set();
    const faltantesIds  = new Set();

    if (validar && !forzar) {
      for (const id of ids) {
        const chk = await runOne(client, `
          WITH orig AS (
            SELECT referencia, COUNT(*) cnt
              FROM doa2.detalle_oc_pendiente
             WHERE id_cabepen = $1
             GROUP BY referencia
          ),
          mat AS (
            SELECT d.referencia, COUNT(*) cnt
              FROM doa2.detalle_oc_pendiente d
              JOIN doa2.item i ON UPPER(TRIM(i.referencia)) = UPPER(TRIM(d.referencia))
              JOIN doa2.item_x_categoria ic ON ic.item_id_item = i.id_item AND ic.estado_registro='A'
             WHERE d.id_cabepen = $1
             GROUP BY d.referencia
          )
          SELECT
            COALESCE((SELECT SUM(cnt) FROM orig),0) AS total,
            COALESCE((SELECT SUM(cnt) FROM mat),0)  AS homologadas,
            ARRAY(
              SELECT o.referencia
                FROM orig o
           LEFT JOIN mat m ON m.referencia = o.referencia
               WHERE COALESCE(m.cnt,0) < o.cnt
               ORDER BY o.referencia
            ) AS faltantes
        `, [id]);

        const total = Number(chk?.total || 0);
        const homol = Number(chk?.homologadas || 0);
        if (homol !== total) {
          (chk?.faltantes || []).forEach(r => faltantesRefs.add(String(r)));
          faltantesIds.add(id);
        }
      }

      if (faltantesRefs.size > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Faltan homologaciones",
          referencias: [...faltantesRefs],
          ids: [...faltantesIds],
        });
      }
    }

    const movidas = [];
    const errores = [];
    const flujos  = [];

    for (const id of ids) {
      try {
        // ---- Lock de la pendiente
        const p = await runOne(client, `
          SELECT *
            FROM doa2.cabecera_oc_pendientes
           WHERE id_cabepen = $1::bigint AND estado_registro='A'
           LIMIT 1
           FOR UPDATE
        `, [id]);
        if (!p) { errores.push({ id, error: "No encontrada" }); continue; }
        if (!String(p.centrocosto || "").trim()) {
          errores.push({ id, error: "Sin centro de costo" }); continue;
        }

        // ---- Si ya está iniciada, no dupliques
        let yaExiste = false;
        if (hasOrigen) {
          const r0 = await run(client, `SELECT 1 FROM doa2.cabecera_oc WHERE origen_pendiente_id=$1 LIMIT 1`, [id]);
          yaExiste = r0.rowCount > 0;
        }
        if (!yaExiste && p.numero_orden_compra) {
          const r1 = await run(client, `
            SELECT 1
              FROM doa2.cabecera_oc
             WHERE estado_registro='A'
               AND TRIM(COALESCE(numero_orden_compra,'')) <> ''
               AND TRIM(numero_orden_compra) = TRIM($1)
             LIMIT 1
          `, [p.numero_orden_compra]);
          yaExiste = r1.rowCount > 0;
        }
        if (yaExiste) { errores.push({ id, error: "Ya iniciada (por id/orden)" }); continue; }

        // ---- Modo preview: no persiste
        if (!persist) {
          movidas.push({ idPendiente: id, idCabecera: 0, numeroOrden: p.numero_orden_compra });
          continue;
        }

        // ==== Anti “pendiente fantasma”: inactiva cualquier otra pendiente con el mismo PO ====
        if (p.numero_orden_compra) {
          await run(client, `
            UPDATE doa2.cabecera_oc_pendientes
               SET estado_registro='I', orden_gestionada='S',
                   oper_modifica=$2, fecha_modificacion=NOW()
             WHERE TRIM(COALESCE(numero_orden_compra,'')) <> ''
               AND TRIM(numero_orden_compra) = TRIM($1)
               AND estado_registro='A'
               AND id_cabepen <> $3
          `, [p.numero_orden_compra, usuario, id]);
          await run(client, `
            UPDATE doa2.detalle_oc_pendiente d
               SET estado_registro='I'
              FROM doa2.cabecera_oc_pendientes c
             WHERE d.id_cabepen = c.id_cabepen
               AND c.estado_registro='I'
               AND TRIM(COALESCE(c.numero_orden_compra,'')) <> ''
               AND TRIM(c.numero_orden_compra) = TRIM($1)
               AND c.id_cabepen <> $2
          `, [p.numero_orden_compra, id]);
        }

        // ---- Insert cabecera iniciada (estado=1 INICIADO)
        const insCab = await runOne(client, `
          WITH cat_prio AS (
            SELECT ic.categoria_id_cate AS id_cate,
                   MIN(
                     CASE
                       WHEN UPPER(TRIM(cat.categoria)) LIKE 'INTERCOMPANY%' THEN 1
                       WHEN UPPER(TRIM(cat.categoria)) IN ('DIRECTO','PLOMO','DIRECTOPACIFICO') THEN 2
                       ELSE 3
                     END
                   ) AS prio
              FROM doa2.detalle_oc_pendiente d
              JOIN doa2.item             i  ON UPPER(TRIM(i.referencia)) = UPPER(TRIM(d.referencia))
              JOIN doa2.item_x_categoria ic ON ic.item_id_item = i.id_item AND ic.estado_registro='A'
              JOIN doa2.categoria        cat ON cat.id_cate     = ic.categoria_id_cate
             WHERE d.id_cabepen = $1
             GROUP BY ic.categoria_id_cate
             ORDER BY MIN(
               CASE
                 WHEN UPPER(TRIM(cat.categoria)) LIKE 'INTERCOMPANY%' THEN 1
                 WHEN UPPER(TRIM(cat.categoria)) IN ('DIRECTO','PLOMO','DIRECTOPACIFICO') THEN 2
                 ELSE 3
               END
             ) ASC
             LIMIT 1
          )
          INSERT INTO doa2.cabecera_oc
          (
            categoria_id_cate, estado_oc_id_esta,
            numero_solicitud, numero_orden_compra, fecha_sugerida, fecha_orden_compra,
            nombre_proveedor, contacto_proveedor, direccion_proveedor, telefono_proveedor,
            ciudad_proveedor, departamento_proveedor, pais_proveedor,
            nit_proveedor, email_proveedor, fax_proveedor,
            nombre_empresa, direccion_empresa, telefono_empresa, ciudad_empresa, pais_empresa,
            nit_empresa, email_empresa, fax_empresa,
            moneda, forma_de_pago, condiciones_de_pago, email_comprador, lugar_entrega,
            observaciones, observacion_compras,
            usuario_creador, total_bruto, descuento_global, sub_total, valor_iva, total_neto,
            requiere_poliza, requiere_contrato, poliza_gestionada, contrato_gestionada,
            compania, sistema, bodega,
            fecha_creacion, oper_creador,
            estado_registro,
            centro_costo_id_ceco,
            nit_compania, solicitante, email_solicitante, prioridad_orden,
            envio_correo
            ${hasOrigen ? ", origen_pendiente_id" : ""}
          )
          SELECT
            (SELECT id_cate FROM cat_prio), 1,
            c.numero_solicitud, c.numero_orden_compra, c.fecha_sugerida, c.fecha_orden_compra,
            c.nombre_proveedor, c.contacto_proveedor, c.direccion_proveedor, c.telefono_proveedor,
            c.ciudad_proveedor, c.departamento_proveedor, c.pais_proveedor,
            c.nit_proveedor, c.email_proveedor, c.fax_proveedor,
            c.nombre_empresa, c.direccion_empresa, c.telefono_empresa, c.ciudad_empresa, c.pais_empresa,
            c.nit_empresa, c.email_empresa, c.fax_empresa,
            c.moneda, c.forma_de_pago, c.condiciones_de_pago, c.email_comprador, c.lugar_entrega,
            c.observaciones, c.observacion_compras,
            $2, c.total_bruto, c.descuento_global, c.sub_total, c.valor_iva, c.total_neto,
            c.requiere_poliza, c.requiere_contrato, NULL, NULL,
            c.compania, c.sistema, c.bodega,
            NOW(), $2,
            'A',
            (SELECT id_ceco FROM doa2.centro_costo cc
              WHERE cc.estado_registro='A' AND UPPER(TRIM(cc.codigo))=UPPER(TRIM(c.centrocosto))
              LIMIT 1),
            c.nit_compania, c.solicitante, c.correo_solicitante, c.prioridad_orden,
            c.envio_correo
            ${hasOrigen ? ", $1" : ""}
          FROM doa2.cabecera_oc_pendientes c
         WHERE c.id_cabepen = $1
         RETURNING id_cabe
        `, [id, usuario]);

        const idCabecera = insCab?.id_cabe;

        // ---- Copiar detalle (fix anti duplicados homologados)
        await run(client, `
          WITH src AS (
            SELECT
              d.id_deta_pendiente,
              d.referencia,
              d.descripcion_referencia,
              d.fecha_entrega,
              d.unidad_medida,
              d.cantidad,
              d.valor_unidad,
              d.iva,
              d.valor_iva,
              d.descuento,
              d.valor_descuento,
              d.valor_sin_iva_descuento,
              d.valor_total
            FROM doa2.detalle_oc_pendiente d
            WHERE d.id_cabepen = $1
          ),
          pick AS (
            SELECT s.*, il.id_itca
            FROM src s
            LEFT JOIN LATERAL (
              SELECT ic.id_itca
              FROM doa2.item i
              JOIN doa2.item_x_categoria ic
                ON ic.item_id_item = i.id_item
               AND ic.estado_registro='A'
              LEFT JOIN doa2.categoria cat ON cat.id_cate = ic.categoria_id_cate
              WHERE UPPER(TRIM(i.referencia)) = UPPER(TRIM(s.referencia))
              ORDER BY
                CASE
                  WHEN UPPER(TRIM(cat.categoria)) LIKE 'INTERCOMPANY%' THEN 1
                  WHEN UPPER(TRIM(cat.categoria)) IN ('DIRECTO','PLOMO','DIRECTOPACIFICO') THEN 2
                  ELSE 3
                END,
                ic.id_itca
              LIMIT 1
            ) il ON TRUE
          )
          INSERT INTO doa2.detalle_oc
            (cabecera_oc_id_cabe, item_x_categoria_id_itca,
             referencia, descripcion_referencia, fecha_entrega, unidad_medida,
             cantidad, valor_unidad, iva, valor_iva, descuento, valor_descuento,
             valor_sin_iva_descuento, valor_total,
             fecha_creacion, oper_creador, estado_registro)
          SELECT
            $2, p.id_itca,
            p.referencia, p.descripcion_referencia, p.fecha_entrega, p.unidad_medida,
            p.cantidad, p.valor_unidad, p.iva, p.valor_iva, p.descuento, p.valor_descuento,
            p.valor_sin_iva_descuento, p.valor_total,
            NOW(), $3, 'A'
          FROM pick p
          WHERE p.id_itca IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM doa2.detalle_oc x
              WHERE x.cabecera_oc_id_cabe = $2
                AND x.referencia    = p.referencia
                AND x.unidad_medida = p.unidad_medida
                AND x.fecha_entrega IS NOT DISTINCT FROM p.fecha_entrega
                AND x.cantidad      = p.cantidad
                AND x.valor_unidad  = p.valor_unidad
            );
        `, [id, idCabecera, usuario]);

        // ---- Recalcular totales reales desde detalle_oc
        await run(client, `
          UPDATE doa2.cabecera_oc co
          SET total_bruto      = t.total_bruto,
              descuento_global = t.dcto_global,
              sub_total        = t.sub_total,
              valor_iva        = t.valor_iva,
              total_neto       = t.total_neto
          FROM (
            SELECT
              COALESCE(SUM(d.cantidad * d.valor_unidad),0) AS total_bruto,
              COALESCE(SUM(d.valor_descuento),0)           AS dcto_global,
              COALESCE(SUM(d.valor_sin_iva_descuento),0)   AS sub_total,
              COALESCE(SUM(d.valor_iva),0)                 AS valor_iva,
              COALESCE(SUM(d.valor_total),0)               AS total_neto
            FROM doa2.detalle_oc d
            WHERE d.cabecera_oc_id_cabe = $1
          ) t
          WHERE co.id_cabe = $1
        `, [idCabecera]);

        // ==== Inactivar definitivamente la pendiente actual y su detalle ====
        await run(client, `
          UPDATE doa2.cabecera_oc_pendientes
             SET estado_registro='I', orden_gestionada='S',
                 oper_modifica=$2, fecha_modificacion=NOW()
           WHERE id_cabepen=$1
        `, [id, usuario]);

        await run(client, `
          UPDATE doa2.detalle_oc_pendiente
             SET estado_registro='I'
           WHERE id_cabepen=$1
        `, [id]);

        // ---- Reglas y flujo (sin lista_autorizaccion_persona)
        const evalOut = await evaluarReglasParaCabecera(idCabecera, client);
        if (evalOut.ok) {
          const persisted = await persistirFlujoAutorizacion({
            client,
            idCabecera,
            centroCosto: evalOut.regla.centroCosto,
            aprobadores: evalOut.aprobadores,
            usuario,
          });
          flujos.push({
            idCabecera,
            numeroOrden: p.numero_orden_compra,
            ok: true,
            regla: evalOut.regla,
            pasos: persisted?.pasos ?? [],
            aprobadores: evalOut.aprobadores,
            persisted,
          });
        } else {
          flujos.push({
            idCabecera,
            numeroOrden: p.numero_orden_compra,
            ok: false,
            pasos: [],
            error: evalOut.reason || "sin regla",
          });
        }

        movidas.push({ idPendiente: id, idCabecera, numeroOrden: p.numero_orden_compra });
      } catch (e) {
        console.error("iniciar error id", id, e);
        errores.push({ id, error: String(e.message || e) });
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, movidas, flujos, errores });
  } catch (e) {
    if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
    console.error("POST /doa/po/iniciar", e);
    res.status(500).json({ ok: false, error: "No se pudo iniciar" });
  } finally {
    if (client) client.release();
  }
});

/* ========================= Services/WS ========================= */
router.post("/doa/po/actualizar-ordenes", async (_req, res) => {
  const r = await actualizarOrdenesComprasQAD();
  if (!r.ok) return res.status(500).json(r);
  res.json(r);
});
router.post("/doa/po/sync", async (_req, res) => {
  const r = await actualizarOrdenesComprasQAD();
  if (!r.ok) return res.status(500).json(r);
  res.json(r);
});
router.post("/doa/po/update-state", async (req, res) => {
  try {
    const domain = norm(req.body?.domain || req.body?.dominio);
    const po = norm(req.body?.po || req.body?.numpo || req.body?.numero);
    const estado = norm(req.body?.estado || "p");
    if (!domain || !po)
      return res.status(400).json({ error: "Faltan domain/po" });

    const out = await updatePoStateSOAP({ domain, po, estado });
    res.json({ ok: out.ok, status: out.status, raw: out.body });
  } catch (e) {
    console.error("POST /doa/po/update-state", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== ¿Se puede editar la OC pendiente? ======
router.get(['/doa/po/ordenes/:id/editar-permitido', '/doa/po/puede-editar/:id'], async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

  try {
    // Traer la pendiente (activa)
    const p = await runOne(pool, `
      SELECT
        c0p.id_cabepen,
        TRIM(COALESCE(c0p.centrocosto,''))          AS cc,
        TRIM(COALESCE(c0p.numero_orden_compra,''))  AS po
      FROM doa2.cabecera_oc_pendientes c0p
      WHERE c0p.id_cabepen = $1::bigint
        AND c0p.estado_registro = 'A'
      LIMIT 1
    `, [id]);

    if (!p) return res.status(404).json({ error: 'OC pendiente no encontrada' });

    // ¿ya iniciada?
    const hasOrigen = await hasColumn('doa2', 'cabecera_oc', 'origen_pendiente_id', pool);
    let iniciada = false;

    if (hasOrigen) {
      const r0 = await run(pool, `SELECT 1 FROM doa2.cabecera_oc WHERE origen_pendiente_id=$1 LIMIT 1`, [id]);
      iniciada = r0.rowCount > 0;
    }
    if (!iniciada && p.po) {
      const r1 = await run(pool, `
        SELECT 1
        FROM doa2.cabecera_oc
        WHERE estado_registro='A'
          AND TRIM(COALESCE(numero_orden_compra,'')) <> ''
          AND TRIM(numero_orden_compra) = TRIM($1)
        LIMIT 1
      `, [p.po]);
      iniciada = r1.rowCount > 0;
    }

    const tieneCentroCosto = !!p.cc;
    const permitido = !iniciada && tieneCentroCosto;

    return res.json({
      permitido,
      iniciada,
      tieneCentroCosto,
      motivo: permitido
        ? null
        : (iniciada
            ? 'La orden ya fue iniciada en el flujo.'
            : (!tieneCentroCosto
                ? 'La orden no tiene centro de costo.'
                : 'Edición no permitida.')),
    });
  } catch (e) {
    console.error('[GET editar-permitido]', e);
    return res.status(500).json({ error: 'No se pudo validar edición' });
  }
});


export default router;
